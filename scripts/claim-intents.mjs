// Claim leg (PRIMARY — Rozo Intents) — claim a parked intents payout as the
// recipient, paying ZERO gas. Rozo sponsors the reserves and fees; the
// recipient's only action is signing locally with their own key.
//
//   export STELLAR_SECRET=S...            # recipient secret key (or wallets/ file)
//   node scripts/claim-intents.mjs --payment <paymentId>
//   node scripts/claim-intents.mjs        # paymentId from newest wallets/*.payment.txt
//   node scripts/claim-intents.mjs --max-fee 0.40   # cap the in-transaction claim fee yourself
//
// The transaction the API returns is verified against the quote before it is
// signed (scripts/xdr-guard.mjs) — nothing is signed blind. The fee ceiling used
// for that check comes from wallets/<paymentId>.quote.json, frozen by
// deposit-intents.mjs when you accepted the quote, not from the live response.
//
// Flow: GET /payments/:id/claim → POST .../claim/transaction {claimant}
// (Idempotency-Key) → sign locally → POST .../claim/submit (Idempotency-Key)
// → poll claim status → verify USDC on Horizon.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import StellarSdk from '@stellar/stellar-sdk';
import { verifyUnsignedXdr, USDC_ISSUER } from './xdr-guard.mjs';

const { Keypair } = StellarSdk;
const INTENTS_API = process.env.INTENTS_API ?? 'https://intentapiv4.rozo.ai/functions/v1/payment-api';
const HORIZON = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);

// --- recipient key + payment id ---
let secret = process.env.STELLAR_SECRET;
let paymentId = args.payment;
const dir = path.join(root, 'wallets');
if (!secret || !paymentId) {
  const walletFiles = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith('stellar-') && f.endsWith('.txt') && !f.includes('.payment.')).sort()
    : [];
  const newest = args.wallet ? path.resolve(root, args.wallet) : (walletFiles.length ? path.join(dir, walletFiles.at(-1)) : null);
  if (!secret) {
    if (!newest) { console.error('no STELLAR_SECRET / --wallet / wallets/stellar-*.txt'); process.exit(1); }
    secret = fs.readFileSync(newest, 'utf8').match(/^secret=(.*)$/m)[1].trim();
  }
  if (!paymentId && newest) {
    const pf = newest.replace('.txt', '.payment.txt');
    if (fs.existsSync(pf)) paymentId = fs.readFileSync(pf, 'utf8').trim();
  }
}
if (!paymentId) { console.error('no --payment and no wallets/*.payment.txt'); process.exit(1); }
const kp = Keypair.fromSecret(secret);
const G = kp.publicKey();
console.log(`claiming payment ${paymentId} as ${G}`);

// --- 1. claim status ---
const claimRes = await fetch(`${INTENTS_API}/payments/${paymentId}/claim`);
if (!claimRes.ok) {
  console.error(`GET claim → ${claimRes.status}`, await claimRes.text());
  if (claimRes.status === 404) console.error('(no claim for this payment, or claim surface not deployed — see README)');
  process.exit(1);
}
const claim = await claimRes.json();
const usd2 = (v) => (v === undefined || v === null ? null : `≈ $${Number(v).toFixed(2)}`);
console.log(`claim status: ${claim.status}`);
if (claim.amount) console.log(`claim amount: ${claim.amount} (${usd2(claim.amount)})`);
if (claim.sponsorFee) console.log(`sponsor fee:  ${claim.sponsorFee} (${usd2(claim.sponsorFee)})`);
if (claim.netAmount) console.log(`net to you:   ${claim.netAmount} (${usd2(claim.netAmount)})`);

// --- 2. build sponsored claim transaction ---
const buildRes = await fetch(`${INTENTS_API}/payments/${paymentId}/claim/transaction`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify({ claimant: G }),
});
const built = await buildRes.json();
if (!buildRes.ok) { console.error('build failed:', buildRes.status, JSON.stringify(built)); process.exit(1); }
const { transactionId, unsignedXdr, networkPassphrase, expiresAt } = built;
console.log(`ticket ${transactionId} (expires ${expiresAt})`);

// --- 3. verify what the server built, then sign locally ---
// Signing whatever the API hands back would let a compromised or misconfigured
// INTENTS_API collect your signature on an unrelated payment or account change.
// Check it first — see xdr-guard.mjs.
// The claim fee is settled as a USDC payment from you to Rozo custody inside
// the same transaction, so the guard needs to know what that payment may be.
//
// That ceiling must NEVER come from the same server that builds the XDR, or a
// hostile deployment can inflate `claim.sponsorFee`, build a matching payment,
// and the guard would wave it through. Only two sources are trusted, both local:
//   1. --max-fee              — you said it, on this machine
//   2. wallets/<id>.quote.json — the fee deposit-intents.mjs froze at the moment
//                                you accepted the quote and spent real money
// With neither, no cap is passed at all: the guard then refuses any outgoing
// payment, so the run stops instead of signing one priced by the server.
const serverFee =
  claim.sponsorFee ??
  claim.totalFee ??
  (claim.amount !== undefined && claim.netAmount !== undefined
    ? (Number(claim.amount) - Number(claim.netAmount)).toFixed(7)
    : undefined);

let quotedAtDeposit;
const quoteFile = path.join(root, 'wallets', `${paymentId}.quote.json`);
if (fs.existsSync(quoteFile)) {
  try {
    const saved = JSON.parse(fs.readFileSync(quoteFile, 'utf8'));
    if (saved.sponsorFee !== null && saved.sponsorFee !== undefined) {
      quotedAtDeposit = String(saved.sponsorFee);
      console.log(`accepted quote (frozen at deposit): sponsor fee ${quotedAtDeposit}`);
    }
  } catch {
    console.warn(`could not parse ${path.relative(root, quoteFile)} — ignoring it`);
  }
}

const maxSelfPayment = args['max-fee'] ?? quotedAtDeposit;
if (maxSelfPayment !== undefined) {
  // The server may quote less than you accepted (fine) but never more.
  if (serverFee !== undefined && Number(serverFee) > Number(maxSelfPayment) + 1e-7) {
    console.error(`\n✋ the API now quotes a ${serverFee} sponsor fee, above the ${maxSelfPayment} you accepted.`);
    console.error('   nothing was signed. Re-run with --max-fee <amount> if this increase is expected.');
    process.exit(1);
  }
} else {
  console.warn('no locally frozen quote for this payment (wallets/<paymentId>.quote.json is written by');
  console.warn('deposit-intents.mjs when you accept the quote). The fee the API reports right now is not');
  console.warn(`trusted as a ceiling${serverFee === undefined ? '' : ` (it says ${serverFee})`}, so any outgoing payment in this transaction will be`);
  console.warn('refused. Re-run with --max-fee <amount> once you decide what you are willing to pay.');
}
let tx;
try {
  tx = verifyUnsignedXdr(unsignedXdr, networkPassphrase, {
    self: G,
    flow: 'claim',
    claimableBalanceId: claim.claimableBalanceId,
    maxSelfPayment,
  });
} catch (err) {
  console.error(`\n✋ refusing to sign the transaction the API returned: ${err.message}`);
  console.error('   nothing was signed and nothing was spent.');
  process.exit(1);
}
tx.sign(kp);
const signedXdr = tx.toXDR();
console.log('signed locally');

// --- 4. submit; retry the same ticket on the tx_too_early flake ---
// One Idempotency-Key for the whole logical submit: retries replay the same
// operation instead of registering as new ones.
const submitIdempotencyKey = crypto.randomUUID();
let submitted = null;
for (let attempt = 1; attempt <= 4; attempt++) {
  const res = await fetch(`${INTENTS_API}/payments/${paymentId}/claim/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submitIdempotencyKey },
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

// --- 5. poll claim until terminal, verify on Horizon ---
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  try {
    const body = await (await fetch(`${INTENTS_API}/payments/${paymentId}/claim`)).json();
    if (['claim_completed', 'claim_confirmed', 'completed'].includes(body.status)) {
      console.log(`claim terminal: ${body.status}`);
      break;
    }
  } catch {
    // transient network/JSON error — keep polling until the deadline
  }
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 6000));
}

const acctRes = await fetch(`${HORIZON}/accounts/${G}`);
if (!acctRes.ok) { console.error(`\naccount not on Horizon (${acctRes.status})`); process.exit(1); }
const acct = await acctRes.json();
// Match the official Centre issuer, not just the asset code: a pre-existing
// trustline to a look-alike "USDC" must not make a failed claim look successful.
const usdc = (acct.balances ?? []).find((b) => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER);
console.log(`\n✅ Horizon USDC balance: ${usdc ? `${usdc.balance} (${usd2(usdc.balance)})` : 'none yet'}`);
if (!usdc || Number(usdc.balance) <= 0) {
  console.error('no official-issuer USDC on the account — the claim did not deliver');
  process.exit(1);
}
if (claim.netAmount && Number(usdc.balance) + 1e-7 < Number(claim.netAmount)) {
  console.error(`balance ${usdc.balance} is below the quoted net ${claim.netAmount} — investigate before calling this a pass`);
  process.exit(1);
}
console.log('claim complete — brand-new wallet received USDC with zero gas paid by the user.');
