// Deposit leg (PRIMARY — Rozo Intents) — create a payment intent through the
// Rozo Intents API and pay it with Base USDC. Destination is a Stellar address;
// if it is a brand-new wallet (no USDC trustline), the payout parks as a
// sponsored claim that scripts/claim-intents.mjs collects with zero gas.
//
//   export DEPOSIT_EVM_PRIVATE_KEY=0x...   # funded Base wallet (USDC + gas ETH)
//   node scripts/deposit-intents.mjs --dest G... --amount 1
//   node scripts/deposit-intents.mjs --amount 1   # recipient = newest wallets/stellar-*.txt
//
// Spends real money. Env overrides: INTENTS_API, APP_ID (default rozoTest so
// demo runs stay out of GMV), BASE_RPC_URL.

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
const amount = args.amount ?? '1';
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

// --- 1. create the intent (Base USDC → Stellar USDC) ---
const orderId = `paysponsor_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const createRes = await fetch(`${INTENTS_API}/payments`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    appId: APP_ID,
    orderId,
    type: 'exactIn',
    display: { title: 'paysponsor demo', currency: 'USD' },
    source: { chainId: '8453', tokenSymbol: 'USDC', amount },
    destination: { chainId: '1500', tokenSymbol: 'USDC', receiverAddress: dest },
  }),
});
const intent = await createRes.json();
if (!createRes.ok || !intent.id) { console.error('create intent failed:', createRes.status, JSON.stringify(intent)); process.exit(1); }
const depositAddress = intent.source.receiverAddress;
console.log(`intent:    ${intent.id}`);
console.log(`deposit:   ${depositAddress}`);
if (walletFile) fs.writeFileSync(walletFile.replace('.txt', '.payment.txt'), `${intent.id}\n`);

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
const deadline = Date.now() + 15 * 60 * 1000;
let status = '';
while (Date.now() < deadline) {
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
  await new Promise((r) => setTimeout(r, 5000));
}
console.error('timed out waiting for delivery or claim');
process.exit(1);
