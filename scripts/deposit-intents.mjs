// Deposit leg (PRIMARY — Rozo Intents) — create a payment intent through the
// Rozo Intents API and pay it with Base USDC. Destination is a Stellar address;
// if it is a brand-new wallet (no USDC trustline), the payout parks as a
// sponsored claim that scripts/claim-intents.mjs collects with zero gas.
//
//   export DEPOSIT_EVM_PRIVATE_KEY=0x...   # funded Base wallet (USDC + gas ETH)
//   node scripts/deposit-intents.mjs --dest G... --amount 1
//   node scripts/deposit-intents.mjs --amount 1     # recipient = newest wallets/stellar-*.txt
//                                                   # (--amount defaults to 0.5)
//
// One invocation = quote THEN pay. There is no quote-only mode: the dry-run
// quote is printed first and the intent is funded straight after, so running
// this twice pays twice. If the API returns no sponsorship quote, it aborts
// before spending anything.
//
// Spends real money. Env overrides: INTENTS_API, APP_ID (default rozoTest so
// test runs stay out of GMV), ROZO_API_KEY (required for your own wallet_* /
// merchant* appId), BASE_RPC_URL.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const INTENTS_API = process.env.INTENTS_API ?? 'https://intentapiv4.rozo.ai/functions/v1/payment-api';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const APP_ID = process.env.APP_ID ?? 'rozoTest';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);

// Own-application appIds (issued at https://partners.rozo.ai) are key-gated:
// the API rejects a create for a `wallet_*` / `merchant*` appId that arrives
// without an X-API-Key. Fail here with a readable message instead of eating a
// server-side 400 after the user has already wired everything up.
// The pairing is "both or neither" in BOTH directions: a key without its own
// appId would ship your application's secret under the public rozoTest identity,
// which is not the account you think you are billing and leaks the key to a
// request that did not need it.
const API_KEY = process.env.ROZO_API_KEY ?? '';
const APP_ID_NEEDS_KEY = APP_ID.startsWith('wallet_') || APP_ID.startsWith('merchant');
if (APP_ID_NEEDS_KEY && !API_KEY) {
  console.error(`APP_ID "${APP_ID}" is a registered application id, which the API only accepts`);
  console.error('together with its API key. Set ROZO_API_KEY in .env (the key issued alongside');
  console.error('the appId at https://partners.rozo.ai), or unset APP_ID to use the public');
  console.error('rozoTest id instead.');
  process.exit(1);
}
if (API_KEY && !APP_ID_NEEDS_KEY) {
  console.error(`ROZO_API_KEY is set but APP_ID is "${APP_ID}", which is not a registered`);
  console.error('application id (those start with "wallet_" or "merchant"). Sending your key');
  console.error('with the public test identity would not activate your application — set APP_ID');
  console.error('to the appId issued alongside this key at https://partners.rozo.ai, or unset');
  console.error('ROZO_API_KEY to run as the public rozoTest id.');
  process.exit(1);
}
// INTENTS_API is an env override, so it is attacker-controllable in exactly the
// scenario this repo warns about — and the API key is a bearer secret. Only ever
// send it to the endpoint it was issued for. A custom endpoint is fine; a custom
// endpoint plus your key is not, unless you say so explicitly.
const DEFAULT_API_HOST = new URL('https://intentapiv4.rozo.ai').host;
if (API_KEY) {
  let url;
  try {
    url = new URL(INTENTS_API);
  } catch {
    console.error(`INTENTS_API is not a valid URL: ${INTENTS_API}`);
    process.exit(1);
  }
  // Plaintext HTTP would put the key on the wire in clear, whatever the host is.
  if (url.protocol !== 'https:') {
    console.error(`refusing to send ROZO_API_KEY over ${url.protocol}// — use https, or unset ROZO_API_KEY.`);
    process.exit(1);
  }
  const host = url.host;
  if (host !== DEFAULT_API_HOST && !('send-my-api-key-to-this-endpoint' in args)) {
    console.error(`refusing to send ROZO_API_KEY to ${host}: it was issued for ${DEFAULT_API_HOST}.`);
    console.error('Unset ROZO_API_KEY (and APP_ID) to call this endpoint anonymously, or pass');
    console.error('--send-my-api-key-to-this-endpoint if you really do control it.');
    process.exit(1);
  }
}
// Secret stays in the header; never logged, never passed as a CLI argument.
const apiHeaders = {
  'Content-Type': 'application/json',
  ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
};

const amount = args.amount ?? '0.5';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// --- recipient ---
let dest = args.dest;
let walletFile = null;
if (!dest) {
  const dir = path.join(root, 'wallets');
  const candidates = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith('stellar-') && !f.includes('.payment.')).sort()
    : [];
  if (!candidates.length) {
    console.error('no --dest and no wallets/stellar-*.txt — run scripts/create-wallet.mjs stellar first');
    process.exit(1);
  }
  walletFile = path.join(dir, candidates.at(-1));
  dest = fs.readFileSync(walletFile, 'utf8').match(/^public=(.*)$/m)[1].trim();
}
console.log(`recipient: ${dest}`);

// --- payer key (env only, never printed) ---
const pk = process.env.DEPOSIT_EVM_PRIVATE_KEY;
if (!pk) { console.error('DEPOSIT_EVM_PRIVATE_KEY is required'); process.exit(1); }
const payer = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
console.log(`payer:     ${payer.address.slice(0, 8)}...${payer.address.slice(-4)}`);

// --- 0. fee quote (dryrun) — preview before spending anything ---
// Same body, same server-side quote path as the real create (the API runs
// prepareStellarGasSponsorPayment in both). Fees are ceiled to whole cents, so
// net = gross − fee lands on a 2dp boundary.
const usd2 = (v) => `$${Number(v).toFixed(2)}`;
const intentBody = {
  appId: APP_ID,
  type: 'exactIn',
  intent: 'stellarsponsor', // opt-in: without this field a no-trustline destination bounces
  display: { title: 'paysponsor demo', currency: 'USD' },
  source: { chainId: '8453', tokenSymbol: 'USDC', amount },
  destination: { chainId: '1500', tokenSymbol: 'USDC', receiverAddress: dest },
};
let quotedSponsorFee = null;
const dryrunRes = await fetch(`${INTENTS_API}/payments?dryrun=true`, {
  method: 'POST',
  headers: apiHeaders,
  body: JSON.stringify(intentBody),
});
const quote = await dryrunRes.json();
if (!dryrunRes.ok) { console.error('dryrun quote failed:', dryrunRes.status, JSON.stringify(quote)); process.exit(1); }
// No quote → no known fee, no proof the claim path exists on this deployment.
// Refuse to spend real money on it unless the caller explicitly overrides.
if (!quote.stellarSponsor) {
  console.error('dryrun returned no stellarSponsor quote — this deployment cannot price (or possibly');
  console.error('cannot serve) the sponsored claim, so funding an intent here risks parking money');
  console.error('with no usable claim path. Aborting without spending anything.');
  console.error('Pass --i-understand-there-is-no-quote to proceed anyway at your own risk.');
  if (!('i-understand-there-is-no-quote' in args)) process.exit(1);
  console.warn('override accepted — continuing without a sponsorship quote');
  quotedSponsorFee = null;
} else {
  const q = quote.stellarSponsor;
  quotedSponsorFee = q.mode === 'direct' ? '0' : (q.sponsorFee ?? null);
  if (q.mode === 'direct') {
    console.log('quote:     destination already has a USDC trustline — no sponsorship, no sponsor fee');
  } else {
    console.log(`quote:     you pay ${amount} USDC on Base`);
    console.log(`           sponsor fee ${q.sponsorFee} (≈ ${usd2(q.sponsorFee)})`);
    console.log(`           recipient nets ${q.netAmount} (≈ ${usd2(q.netAmount)}) after claiming`);
  }
}

// --- 1. create the intent (Base USDC → Stellar USDC) ---
const orderId = `paysponsor_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const createRes = await fetch(`${INTENTS_API}/payments`, {
  method: 'POST',
  headers: apiHeaders,
  body: JSON.stringify({ ...intentBody, orderId }),
});
const intent = await createRes.json();
if (!createRes.ok || !intent.id) { console.error('create intent failed:', createRes.status, JSON.stringify(intent)); process.exit(1); }
const depositAddress = intent.source.receiverAddress;
console.log(`intent:    ${intent.id}`);
console.log(`deposit:   ${depositAddress}`);
if (walletFile) fs.writeFileSync(walletFile.replace('.txt', '.payment.txt'), `${intent.id}\n`);

// Freeze the fee you just accepted. scripts/claim-intents.mjs reads this file
// and refuses to sign a claim whose in-transaction fee payment exceeds it, so a
// server that later inflates `claim.sponsorFee` cannot widen the cap after the
// fact. Written next to the wallet, never leaves the machine, holds no secret.
const quoteFile = path.join(root, 'wallets', `${intent.id}.quote.json`);
fs.mkdirSync(path.dirname(quoteFile), { recursive: true });
fs.writeFileSync(quoteFile, `${JSON.stringify({
  paymentId: intent.id,
  destination: dest,
  amount,
  sponsorFee: quotedSponsorFee,
  quotedAt: new Date().toISOString(),
}, null, 2)}\n`);
console.log(`quote saved: wallets/${intent.id}.quote.json (fee cap for the claim step)`);

// --- 2. pay on Base ---
const rpc = http(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org');
const pub = createPublicClient({ chain: base, transport: rpc });
const wallet = createWalletClient({ chain: base, transport: rpc, account: payer });
const amount6 = parseUnits(amount, 6);
const bal = await pub.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [payer.address] });
if (bal < amount6) { console.error(`insufficient USDC: have ${bal} usdc6, need ${amount6}`); process.exit(1); }
const txHash = await wallet.writeContract({
  address: BASE_USDC, abi: erc20Abi, functionName: 'transfer', args: [depositAddress, amount6],
});
console.log(`base tx:   ${txHash}`);
await pub.waitForTransactionReceipt({ hash: txHash });
console.log('base tx confirmed');

// --- 3. poll payment status; surface the claim once it appears ---
// Parking is not instant — a recorded production run took ~18 min from the Base
// transfer to the claimable balance. Wait generously; the intent id is already
// printed above, so a timeout here is resumable with --payment.
const deadline = Date.now() + 45 * 60 * 1000;
let status = '';
while (Date.now() < deadline) {
  try {
    const body = await (await fetch(`${INTENTS_API}/payments/${intent.id}`)).json();
    const s = body.status ?? body.state;
    if (s !== status) { status = s; console.log(`status:    ${status}`); }
    if (status === 'payment_payout_completed' || status === 'payment_completed') {
      console.log('✅ delivered directly (recipient already had a trustline)');
      process.exit(0);
    }
    const claimRes = await fetch(`${INTENTS_API}/payments/${intent.id}/claim`);
    if (claimRes.ok) {
      const claim = await claimRes.json();
      console.log(`claim:     status=${claim.status}`);
      console.log(`\n✅ parked as a sponsored claim — next:\n  node scripts/claim-intents.mjs --payment ${intent.id}`);
      process.exit(0);
    }
  } catch {
    // transient network/JSON error — the payment is already on-chain, keep polling
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.error('timed out waiting for delivery or claim');
process.exit(1);
