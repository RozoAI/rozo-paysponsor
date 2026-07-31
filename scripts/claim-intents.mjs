// Claim leg (PRIMARY — Rozo Intents) — claim a parked intents payout as the
// recipient, paying ZERO gas. Rozo sponsors the reserves and fees; the
// recipient's only action is signing locally with their own key.
//
//   export STELLAR_SECRET=S...            # recipient secret key (or wallets/ file)
//   node scripts/claim-intents.mjs --payment <paymentId>
//   node scripts/claim-intents.mjs        # paymentId from newest wallets/*.payment.txt
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

const { Keypair, TransactionBuilder } = StellarSdk;
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
console.log(`claim status: ${claim.status}`);

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

// --- 3. sign locally ---
const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
tx.sign(kp);
const signedXdr = tx.toXDR();
console.log('signed locally');

// --- 4. submit; retry the same ticket on the tx_too_early flake ---
let submitted = null;
for (let attempt = 1; attempt <= 4; attempt++) {
  const res = await fetch(`${INTENTS_API}/payments/${paymentId}/claim/submit`, {
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

// --- 5. poll claim until terminal, verify on Horizon ---
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  const body = await (await fetch(`${INTENTS_API}/payments/${paymentId}/claim`)).json();
  if (['claim_completed', 'claim_confirmed', 'completed'].includes(body.status)) {
    console.log(`claim terminal: ${body.status}`);
    break;
  }
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
