// Deposit leg — send USDC from Base to a Stellar address through the Rozo
// bridge API. If the recipient is a brand-new wallet (no trustline), the
// delivery parks as `awaiting_trustline` and scripts/claim.mjs collects it.
//
//   export DEPOSIT_EVM_PRIVATE_KEY=0x...   # funded Base wallet (USDC + gas ETH)
//   node scripts/deposit.mjs --dest G... --amount 1
//   node scripts/deposit.mjs --amount 1    # recipient = newest wallets/stellar-*.txt
//
// Spends real money. Env overrides: BRIDGE_API, CLAIM_API, BASE_RPC_URL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const BRIDGE_API = process.env.BRIDGE_API ?? 'https://api-production-dd86.up.railway.app';
const CLAIM_API = process.env.CLAIM_API ?? 'https://intentapiv4.rozo.ai/functions/v1/payment-api';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

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
    ? fs.readdirSync(dir).filter((f) => f.startsWith('stellar-')).sort()
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

// --- 1. create bridge payment ---
const createRes = await fetch(`${BRIDGE_API}/payments`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    direction: 'base_to_stellar',
    sourceChain: '8453',
    destChain: 'stellar',
    amount,
    sourceAddress: payer.address,
    destAddress: dest,
    turnstileToken: 'paysponsor-demo',
  }),
});
const created = await createRes.json();
if (!createRes.ok) { console.error('create failed:', createRes.status, JSON.stringify(created)); process.exit(1); }
const { paymentId, depositAddress } = created;
console.log(`payment:   ${paymentId}`);
console.log(`deposit:   ${depositAddress}`);
if (walletFile) fs.writeFileSync(walletFile.replace('.txt', '.payment.txt'), `${paymentId}\n`);

// --- 2. send USDC on Base ---
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

// --- 3. notify payin ---
const payinRes = await fetch(`${BRIDGE_API}/payments/${paymentId}/payin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ txHash }),
});
console.log('payin:', payinRes.status, JSON.stringify(await payinRes.json()));

// --- 4. poll status ---
const deadline = Date.now() + 15 * 60 * 1000;
let status = '';
while (Date.now() < deadline) {
  const body = await (await fetch(`${BRIDGE_API}/payments/${paymentId}`)).json();
  if (body.status !== status) { status = body.status; console.log(`status:    ${status}`); }
  if (status === 'completed') { console.log('✅ delivered directly (recipient already had a trustline)'); process.exit(0); }
  if (status === 'awaiting_trustline') break;
  await new Promise((r) => setTimeout(r, 5000));
}
if (status !== 'awaiting_trustline') { console.error('timed out waiting for park/delivery'); process.exit(1); }

const unclaimed = await (await fetch(`${CLAIM_API}/stellar/accounts/${dest}/cctp-unclaimed`)).json();
console.log('unclaimed:', JSON.stringify(unclaimed));
console.log('\n✅ parked awaiting claim — next: node scripts/claim.mjs');
