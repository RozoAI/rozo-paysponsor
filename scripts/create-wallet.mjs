// Generate a fresh wallet for the demo and save it locally (never committed).
//
//   node scripts/create-wallet.mjs stellar   → wallets/stellar-<ts>.txt
//   node scripts/create-wallet.mjs base      → wallets/base-<ts>.txt
//
// The file contains the secret; it is written 0600 and wallets/ is gitignored.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kind = process.argv[2];
if (!['stellar', 'base'].includes(kind ?? '')) {
  console.error('usage: node scripts/create-wallet.mjs <stellar|base>');
  process.exit(1);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'wallets');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const file = path.join(dir, `${kind}-${ts}.txt`);

if (kind === 'stellar') {
  const { Keypair } = (await import('@stellar/stellar-sdk')).default;
  const kp = Keypair.random();
  fs.writeFileSync(file, `secret=${kp.secret()}\npublic=${kp.publicKey()}\n`, { mode: 0o600 });
  console.log(`public:  ${kp.publicKey()}`);
} else {
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  fs.writeFileSync(file, `secret=${pk}\npublic=${account.address}\n`, { mode: 0o600 });
  console.log(`address: ${account.address}`);
}
console.log(`saved:   ${file} (0600 — secret inside, do not commit or paste)`);
