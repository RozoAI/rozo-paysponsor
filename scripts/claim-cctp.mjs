// Claim leg — collect parked USDC as the recipient, paying ZERO gas.
// Rozo's KMS signer sponsors the trustline reserves and transaction fees.
//
//   export STELLAR_SECRET=S...              # recipient secret key
//   node scripts/claim.mjs
//   node scripts/claim.mjs --wallet wallets/stellar-<ts>.txt
//
// Flow: list unclaimed → build sponsored trustline XDR (Idempotency-Key) →
// sign locally → submit (Idempotency-Key) → poll until relayed → verify on
// Horizon. Retries the same ticket on the known tx_too_early submit flake.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import StellarSdk from '@stellar/stellar-sdk';

const { Keypair, TransactionBuilder } = StellarSdk;
const CLAIM_API = process.env.CLAIM_API ?? 'https://intentapiv4.rozo.ai/functions/v1/payment-api';
const HORIZON = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);

// --- recipient key: env, --wallet file, or newest wallets/stellar-*.txt ---
let secret = process.env.STELLAR_SECRET;
if (!secret) {
  let file = args.wallet ? path.resolve(root, args.wallet) : null;
  if (!file) {
    const dir = path.join(root, 'wallets');
    const candidates = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.startsWith('stellar-') && f.endsWith('.txt') && !f.includes('.payment.')).sort()
      : [];
    if (candidates.length) file = path.join(dir, candidates.at(-1));
  }
  if (!file) { console.error('no STELLAR_SECRET, no --wallet, no wallets/stellar-*.txt'); process.exit(1); }
  secret = fs.readFileSync(file, 'utf8').match(/^secret=(.*)$/m)[1].trim();
}
const kp = Keypair.fromSecret(secret);
const G = kp.publicKey();
console.log(`claiming as ${G}`);

// --- 1. list unclaimed ---
const unclaimedRes = await fetch(`${CLAIM_API}/stellar/accounts/${G}/cctp-unclaimed`);
if (!unclaimedRes.ok) {
  console.error(`cctp-unclaimed → ${unclaimedRes.status}`, await unclaimedRes.text());
  if (unclaimedRes.status === 404) console.error('(claim surface not deployed? see README status note)');
  process.exit(1);
}
const unclaimed = await unclaimedRes.json();
console.log(`unclaimed: count=${unclaimed.count} totalUsdc6=${unclaimed.totalAmountUsdc6}`);
if (!unclaimed.count) { console.log('nothing to claim'); process.exit(0); }

// --- 2. build sponsored trustline ticket ---
const buildRes = await fetch(`${CLAIM_API}/stellar/accounts/${G}/sponsor-trustline/transaction`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify({}),
});
const built = await buildRes.json();
if (!buildRes.ok) { console.error('build failed:', buildRes.status, JSON.stringify(built)); process.exit(1); }

if (built.status === 'already_ready') {
  console.log('trustline already exists — executor relays on its own, skipping to polling');
} else {
  const { transactionId, unsignedXdr, networkPassphrase, expiresAt } = built;
  console.log(`ticket ${transactionId} (expires ${expiresAt})`);

  // --- 3. sign locally with the recipient's own key ---
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  tx.sign(kp);
  const signedXdr = tx.toXDR();
  console.log('signed locally');

  // --- 4. submit; retry the SAME ticket on the tx_too_early flake ---
  let submitted = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${CLAIM_API}/stellar/accounts/${G}/sponsor-trustline/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ transactionId, signedXdr }),
    });
    const body = await res.json();
    if (res.ok) { submitted = body; break; }
    console.warn(`submit attempt ${attempt} → ${res.status} ${JSON.stringify(body)}`);
    if (res.status === 422 && attempt < 4) { await new Promise((r) => setTimeout(r, 8000)); continue; }
    process.exit(1);
  }
  console.log(`submit ok: status=${submitted.status} tx=${submitted.transactionHash ?? 'pending'}`);
  if (submitted.horizonUrl) console.log(submitted.horizonUrl);
}

// --- 5. wait for relay, verify balance on Horizon ---
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  const body = await (await fetch(`${CLAIM_API}/stellar/accounts/${G}/cctp-unclaimed`)).json();
  if (body.count === 0) { console.log('unclaimed count is 0 — delivery relayed'); break; }
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 6000));
}

const acctRes = await fetch(`${HORIZON}/accounts/${G}`);
if (!acctRes.ok) { console.error(`\naccount not on Horizon (${acctRes.status})`); process.exit(1); }
const acct = await acctRes.json();
const usdc = (acct.balances ?? []).find((b) => b.asset_code === 'USDC');
console.log(`\n✅ Horizon USDC balance: ${usdc ? usdc.balance : 'none yet'}`);
if (!usdc || Number(usdc.balance) <= 0) process.exit(1);
console.log('claim complete — brand-new wallet received USDC with zero gas paid by the user.');
