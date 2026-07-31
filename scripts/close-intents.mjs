// Close leg (Rozo Intents) — close a sponsored Stellar account with ZERO gas
// paid by the user, sending everything to a destination the user chooses.
//
//   node scripts/close-intents.mjs --destination G...   # required: Stellar G address
//   node scripts/close-intents.mjs --destination G... --wallet wallets/stellar-....txt
//
// The close template is EXACTLY changeTrust(USDC, limit 0) + accountMerge, so
// the API requires USDC=0 before close. This script therefore runs two legs:
//
//   Leg 1 (only if USDC > 0): sponsored transfer sweeps the full USDC balance
//     to the destination.  POST /stellar/transfers/transaction {sourceAddress,
//     destination, asset:"USDC", amount} → sign locally → POST
//     /stellar/transfers/submit → poll Horizon until source USDC = 0.
//   Leg 2: POST /stellar/accounts/close/preflight → POST
//     /stellar/accounts/close/transaction {address, mergeDestination} → sign
//     locally → POST /stellar/accounts/close/submit → poll Horizon until the
//     source account is 404 (merged).
//
// The 95% reserve rebate (~$0.20 USDC) is enqueued server-side at close
// confirmation and paid ASYNCHRONOUSLY from custody by the withdraw-loop
// rebate worker to the SAME destination. This script polls for it briefly but
// does not fail the run if it has not arrived (the rebate pass may not be
// scheduled yet — see the final report line).
//
// Destination requirements (checked up front): exists on Horizon, holds a USDC
// trustline (for the sweep + rebate), and is not the closing account itself.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import StellarSdk from '@stellar/stellar-sdk';

const { Keypair, TransactionBuilder } = StellarSdk;
const INTENTS_API = process.env.INTENTS_API ?? 'https://intentapiv4.rozo.ai/functions/v1/payment-api';
const HORIZON = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);

// --- source key ---
let secret = process.env.STELLAR_SECRET;
if (!secret) {
  const dir = path.join(root, 'wallets');
  const walletFiles = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith('stellar-') && f.endsWith('.txt') && !f.includes('.payment.')).sort()
    : [];
  const newest = args.wallet ? path.resolve(root, args.wallet) : (walletFiles.length ? path.join(dir, walletFiles.at(-1)) : null);
  if (!newest) { console.error('no STELLAR_SECRET / --wallet / wallets/stellar-*.txt'); process.exit(1); }
  secret = fs.readFileSync(newest, 'utf8').match(/^secret=(.*)$/m)[1].trim();
}
const kp = Keypair.fromSecret(secret);
const G = kp.publicKey();

// --- destination (Stellar-only today; Base 0x needs a bridge leg, not supported here) ---
const destination = args.destination;
if (!destination || !/^G[A-Z2-7]{55}$/.test(destination)) {
  console.error('--destination G... is required (Stellar account, must exist and hold a USDC trustline)');
  process.exit(1);
}
if (destination === G) { console.error('destination must differ from the closing account'); process.exit(1); }
console.log(`closing ${G}\n → everything to ${destination}`);

const usdcOf = (acct) =>
  (acct.balances ?? []).find((b) => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER);
async function horizonAccount(address) {
  const res = await fetch(`${HORIZON}/accounts/${address}`);
  if (res.status === 404) return null;
  if (!res.ok) { console.error(`Horizon ${res.status} for ${address}`); process.exit(1); }
  return res.json();
}
async function api(pathname, body, idempotencyKey) {
  const res = await fetch(`${INTENTS_API}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}
function signLocally(unsignedXdr, networkPassphrase) {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  tx.sign(kp);
  return tx.toXDR();
}
// One Idempotency-Key per logical submit; retry the tx_too_early flake.
async function submitWithRetry(pathname, transactionId, signedXdr) {
  const submitIdempotencyKey = crypto.randomUUID();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { res, json } = await api(pathname, { transactionId, signedXdr }, submitIdempotencyKey);
    if (res.ok || res.status === 202) return json;
    console.warn(`submit attempt ${attempt} → ${res.status} ${JSON.stringify(json)}`);
    if (res.status === 422 && attempt < 4) { await new Promise((r) => setTimeout(r, 8000)); continue; }
    process.exit(1);
  }
}
async function poll(label, deadlineMs, fn) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const done = await fn();
      if (done) return true;
    } catch { /* transient — keep polling */ }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 6000));
  }
  console.error(`\ntimed out waiting for: ${label}`);
  return false;
}

// --- 0. snapshot both accounts ---
const src = await horizonAccount(G);
if (!src) { console.error('source account not found on Horizon (already merged?)'); process.exit(1); }
const dst = await horizonAccount(destination);
if (!dst) { console.error('destination does not exist on Horizon — merge would fail'); process.exit(1); }
const dstUsdcTrust = usdcOf(dst);
if (!dstUsdcTrust) { console.error('destination has no official USDC trustline — sweep/rebate would fail'); process.exit(1); }
const srcUsdc = usdcOf(src)?.balance ?? '0';
const dstUsdcBefore = dstUsdcTrust.balance;
const dstXlmBefore = (dst.balances ?? []).find((b) => b.asset_type === 'native')?.balance ?? '0';
console.log(`source USDC: ${srcUsdc} | destination USDC before: ${dstUsdcBefore} | destination XLM before: ${dstXlmBefore}`);

// --- 1. sweep USDC if nonzero (close requires USDC=0) ---
if (Number(srcUsdc) > 0) {
  console.log(`\nleg 1 — sponsored transfer of ${srcUsdc} USDC to destination`);
  const { res, json } = await api('/stellar/transfers/transaction', {
    sourceAddress: G,
    destination,
    asset: 'USDC',
    amount: srcUsdc,
  }, crypto.randomUUID());
  if (!res.ok) { console.error('transfer build failed:', res.status, JSON.stringify(json)); process.exit(1); }
  console.log(`transfer ticket ${json.transactionId} (expires ${json.expiresAt})`);
  const signed = signLocally(json.unsignedXdr, json.networkPassphrase);
  const submitted = await submitWithRetry('/stellar/transfers/submit', json.transactionId, signed);
  console.log(`transfer submit: status=${submitted.status} tx=${submitted.transactionHash ?? 'pending'}`);
  const swept = await poll('source USDC to reach 0', 5 * 60 * 1000, async () => {
    const a = await horizonAccount(G);
    return a && Number(usdcOf(a)?.balance ?? '0') === 0;
  });
  if (!swept) process.exit(1);
  console.log('\nsource USDC is 0 — close is now possible');
}

// --- 2. close preflight ---
console.log('\nleg 2 — sponsored account close');
{
  const { res, json } = await api('/stellar/accounts/close/preflight', { address: G, mergeDestination: destination });
  if (!res.ok) { console.error('preflight failed:', res.status, JSON.stringify(json)); process.exit(1); }
  if (!json.close?.eligible) {
    console.error('account not closable, blockers:', JSON.stringify(json.close?.blockers));
    process.exit(1);
  }
  console.log('preflight: eligible');
}

// --- 3. build + sign + submit close ---
const { res: buildRes, json: built } = await api('/stellar/accounts/close/transaction', {
  address: G,
  mergeDestination: destination,
}, crypto.randomUUID());
if (!buildRes.ok) { console.error('close build failed:', buildRes.status, JSON.stringify(built)); process.exit(1); }
console.log(`close ticket ${built.transactionId} (expires ${built.expiresAt})`);
const signedClose = signLocally(built.unsignedXdr, built.networkPassphrase);
const closeSubmitted = await submitWithRetry('/stellar/accounts/close/submit', built.transactionId, signedClose);
console.log(`close submit: status=${closeSubmitted.status} tx=${closeSubmitted.transactionHash ?? 'pending'}`);
if (closeSubmitted.horizonUrl) console.log(closeSubmitted.horizonUrl);

// --- 4. verify: source 404 on Horizon (merged) ---
const merged = await poll('source account 404 (merged)', 5 * 60 * 1000, async () => (await horizonAccount(G)) === null);
if (!merged) process.exit(1);
console.log('\n✅ source account is gone from Horizon (accountMerge landed)');

// --- 5. verify destination deltas: sweep now, rebate best-effort ---
const dstAfter = await horizonAccount(destination);
const dstUsdcAfter = usdcOf(dstAfter)?.balance ?? '0';
const dstXlmAfter = (dstAfter.balances ?? []).find((b) => b.asset_type === 'native')?.balance ?? '0';
const usdcDelta = (Number(dstUsdcAfter) - Number(dstUsdcBefore)).toFixed(7);
const usd2 = (v) => `≈ $${Number(v).toFixed(2)}`;
console.log(`destination USDC: ${dstUsdcBefore} → ${dstUsdcAfter} (Δ ${usdcDelta} ${usd2(usdcDelta)}; expected ≥ swept ${srcUsdc})`);
console.log(`destination XLM:  ${dstXlmBefore} → ${dstXlmAfter} (merge moves the user's own native balance, sponsored reserves return to Rozo)`);
if (Number(usdcDelta) + 1e-7 < Number(srcUsdc)) {
  console.error('destination USDC delta is below the swept amount — investigate before calling this a pass');
  process.exit(1);
}

// --- 6. rebate (async, paid by the withdraw-loop rebate worker) ---
console.log('\nwaiting up to 3 min for the ~95% reserve rebate (USDC from custody)...');
const rebated = await poll('rebate arrival', 3 * 60 * 1000, async () => {
  const a = await horizonAccount(destination);
  return Number(usdcOf(a)?.balance ?? '0') > Number(dstUsdcAfter) + 1e-7;
});
if (rebated) {
  const fin = await horizonAccount(destination);
  const finUsdc = usdcOf(fin)?.balance ?? '0';
  const rebateDelta = (Number(finUsdc) - Number(dstUsdcAfter)).toFixed(7);
  console.log(`\n✅ rebate received: destination USDC now ${finUsdc} (Δ ${rebateDelta} ${usd2(rebateDelta)})`);
} else {
  console.warn('rebate not seen yet — it is queued server-side (stellar close-rebate outbox) and pays out when the withdraw-loop rebate pass runs. Not a close failure.');
}
console.log('\nclose complete — account merged, balance delivered, user paid zero gas.');
