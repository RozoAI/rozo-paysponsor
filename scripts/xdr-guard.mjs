// Verify a server-built Stellar transaction BEFORE signing it.
//
// Every sponsored flow here works the same way: you ask Rozo's API to
// build a transaction, and you sign it locally with your own key. That is the
// right shape — your secret never leaves your machine — but it is only safe if
// you actually look at what you are signing. A compromised, misconfigured or
// simply mistyped `INTENTS_API` could otherwise hand you a valid signature on a
// payment to an attacker, a signer change, or an account merge you never asked
// for.
//
// So: parse the XDR, insist on public network, and check every operation that
// your key would authorize (op source is you, or no op source and the
// transaction source is you — compared on the underlying `G…` account, so a
// muxed `M…` alias of your address cannot dodge the check) against an explicit,
// per-flow expectation. Any operation type outside the allowlist, or any field
// that does not match, is a hard abort.
//
// Operations sourced by somebody else are usually Rozo's (the sponsor paying
// your reserves and fees) and your signature normally adds nothing to them. But
// "normally" is not "never": if your key happens to be a registered signer on
// some other Stellar account, your signature would authorize that account's
// operations too. So a foreign-sourced operation is held to a much shorter
// allowlist — only the sponsorship plumbing, which cannot move funds — and
// anything that could spend (payment, accountMerge, changeTrust, claiming a
// balance) is refused outright unless it is yours and fully checked.

import StellarSdk from '@stellar/stellar-sdk';

const { TransactionBuilder, Networks, extractBaseAddress } = StellarSdk;

// A muxed account (`M…`) is the SAME Ed25519 key as its base `G…` address with a
// routing id attached, so your signature authorizes it just the same. Comparing
// the raw strings would let a malicious API label your own operation with the
// muxed form of your address, have the guard file it under "not mine", and skip
// every field check on it. Normalize both sides of every address comparison.
const baseAddress = (address) => {
  if (typeof address !== 'string' || !address.startsWith('M')) return address;
  try {
    return extractBaseAddress(address);
  } catch {
    return address; // not a decodable muxed address — compare as-is
  }
};
const sameAccount = (a, b) =>
  a !== undefined && a !== null && b !== undefined && b !== null && baseAddress(a) === baseAddress(b);

// Optional allowlist of the accounts Rozo is allowed to source and fee-pay these
// transactions from. Left empty by default on purpose: production rotates
// through a pool of fee payers (a run recorded here used three different ones),
// so a hard-coded pin would reject perfectly good transactions the day the pool
// changes. Set ROZO_SPONSOR_ADDRESSES=G...,G... to pin it for your own
// deployment; see the residual assumption documented in the README.
const TRUSTED_SPONSORS = new Set(
  (process.env.ROZO_SPONSOR_ADDRESSES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);
const trustedSponsor = (address) =>
  TRUSTED_SPONSORS.size === 0 || TRUSTED_SPONSORS.has(baseAddress(address));

export const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

// Rozo's Stellar custody account: it sponsors the reserves, receives the claim
// fee, and pays the close rebate. Pinning it means a server cannot redirect the
// fee payment somewhere else. Override only if you run your own deployment.
export const ROZO_CUSTODY =
  process.env.ROZO_CUSTODY_ADDRESS ?? 'GBLTI2TTQXUAYNKGCQ63YA55KTFEAOQJ3DPBPELNPWCJVE76ADWMXUAE';

const isOfficialUsdc = (asset) =>
  !!asset && asset.getCode?.() === 'USDC' && asset.getIssuer?.() === USDC_ISSUER;

const assetLabel = (asset) =>
  !asset ? 'none' : asset.isNative?.() ? 'XLM (native)' : `${asset.getCode?.()}:${asset.getIssuer?.()}`;

// 7-decimal Stellar amounts: compare as exact stroop integers, not as strings
// (`"1"` and `"1.0000000"` are the same amount) and not as loose floats.
const sameAmount = (a, b) =>
  Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && stroops(a) === stroops(b);

class XdrRejected extends Error {}
const reject = (msg) => { throw new XdrRejected(msg); };

// Operation types that may legitimately appear in these flows. Anything else —
// setOptions (signer/threshold changes), path payments, offers, clawbacks — is
// refused outright, whoever it is sourced by.
// The transaction fee is charged to the transaction source, which in these
// flows is always Rozo — a fee you would pay is refused outright below. That is
// only "free" as long as your key is not a signer on the sponsor's account, and
// the guard cannot know that, so the sponsor's fee is bounded too: 1 XLM, wide
// enough for any realistic surge-priced sponsored transaction (a handful of
// operations at a 100-stroop base fee) and a bounded loss rather than an open
// -ended one.
const MAX_SPONSOR_FEE_STROOPS = 10_000_000;

const ALLOWED_TYPES = new Set([
  'createAccount',
  'payment',
  'changeTrust',
  'accountMerge',
  'claimClaimableBalance',
  'beginSponsoringFutureReserves',
  'endSponsoringFutureReserves',
  'revokeAccountSponsorship',
  'revokeTrustlineSponsorship',
  'revokeClaimableBalanceSponsorship',
  'revokeSignerSponsorship',
  'revokeDataSponsorship',
]);

// Of those, the only ones acceptable from an account that is NOT yours. None of
// them can move an asset balance out of the account that sources them, so even
// if your key turns out to be a signer there, signing costs you nothing.
// `createAccount` is on the list because the sponsor uses it to create YOUR
// account — it is additionally required to have a zero starting balance below.
const ALLOWED_FOREIGN_TYPES = new Set([
  'createAccount',
  'beginSponsoringFutureReserves',
  'endSponsoringFutureReserves',
  'revokeAccountSponsorship',
  'revokeTrustlineSponsorship',
  'revokeClaimableBalanceSponsorship',
  'revokeSignerSponsorship',
  'revokeDataSponsorship',
]);

// Stellar amounts are exact to 7 decimals; compare them as integer stroops so a
// float rounding slack cannot be used to sneak past a cap.
const stroops = (v) => Math.round(Number(v) * 1e7);

/**
 * @param {string}  unsignedXdr        as returned by the API
 * @param {string}  networkPassphrase  as returned by the API
 * @param {object}  expect
 * @param {string}  expect.self        your own G address (the signer)
 * @param {'claim'|'transfer'|'close'} expect.flow
 * @param {string} [expect.destination]        transfer: required payment destination
 * @param {string} [expect.amount]             transfer: required payment amount
 * @param {string} [expect.mergeDestination]   close: required accountMerge destination
 * @param {string} [expect.maxSelfPayment]     claim: largest USDC payment you may make (the quoted fee)
 * @returns {import('@stellar/stellar-sdk').Transaction} the parsed transaction
 */
export function verifyUnsignedXdr(unsignedXdr, networkPassphrase, expect) {
  const { self, flow } = expect;
  if (networkPassphrase !== Networks.PUBLIC) {
    reject(`network passphrase is not Stellar public network: ${JSON.stringify(networkPassphrase)}`);
  }

  // Every fee field of every envelope your signature covers gets checked. These
  // flows are sponsor-paid end to end — "zero gas" is the whole point — so a
  // transaction whose fee you would pay is not a price change, it is a wrong
  // transaction. Refuse it outright rather than haggle over the amount.
  const checkFee = (envelope) => {
    // Plain transactions expose `source`; a fee bump charges its `feeSource`.
    const feeSource = envelope.source ?? envelope.feeSource;
    if (sameAccount(feeSource, self)) {
      reject(`transaction fee would be paid by you (${feeSource}); every transaction in these flows is fee-paid by the sponsor`);
    }
    if (!trustedSponsor(feeSource)) {
      reject(`transaction fee is paid by ${feeSource}, which is not in ROZO_SPONSOR_ADDRESSES`);
    }
    const feeStroops = Number(envelope.fee);
    if (!Number.isFinite(feeStroops) || feeStroops > MAX_SPONSOR_FEE_STROOPS) {
      reject(`transaction fee ${envelope.fee} stroops is above the ${MAX_SPONSOR_FEE_STROOPS} ceiling for a transaction sourced by ${feeSource}`);
    }
  };

  let tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  // A fee bump wraps the transaction that actually carries the operations. Its
  // own fee field is separate and is charged to the fee-bump source, so check
  // it before unwrapping.
  if (tx.innerTransaction) {
    checkFee(tx);
    tx = tx.innerTransaction;
  }
  if (!Array.isArray(tx.operations) || tx.operations.length === 0) reject('transaction carries no operations');
  checkFee(tx);

  const ours = [];
  const foreign = [];
  for (const [i, op] of tx.operations.entries()) {
    const source = op.source ?? tx.source;
    const mine = sameAccount(source, self);
    const where = `operation ${i + 1} (${op.type}${mine ? ', signed by you' : ''})`;

    if (!ALLOWED_TYPES.has(op.type)) reject(`${where}: operation type is not part of this flow`);
    if (!mine) {
      // Your key may be a signer on this other account without you thinking of
      // it as "yours"; only accept operations that cannot spend anything.
      if (!trustedSponsor(source)) {
        reject(`${where}: sourced by ${source}, which is not in ROZO_SPONSOR_ADDRESSES`);
      }
      if (!ALLOWED_FOREIGN_TYPES.has(op.type)) {
        reject(`${where}: sourced by ${source}, and a ${op.type} from an account that is not yours could still be authorized by your signature`);
      }
      if (op.type === 'createAccount' && stroops(op.startingBalance) !== 0) {
        reject(`${where}: sourced by ${source} and funds ${op.startingBalance} XLM — a sponsored create starts at 0`);
      }
      // Not spending is not the same as not costing. A sponsorship or account
      // creation sourced by an account your key can sign for locks that
      // account's XLM in base reserves. Only the ones aimed at YOUR account —
      // the sponsor creating the wallet you are claiming into — are expected.
      if (op.type === 'createAccount' && op.destination !== self) {
        reject(`${where}: sourced by ${source} and creates ${op.destination}, which is not your account — that would lock reserves on an account your key can sign for`);
      }
      if (op.type === 'beginSponsoringFutureReserves' && op.sponsoredId !== self) {
        reject(`${where}: sourced by ${source} and sponsors ${op.sponsoredId}, expected your own account`);
      }
      foreign.push(op.type);
      continue;
    }
    ours.push(op.type);

    switch (op.type) {
      case 'payment': {
        if (!isOfficialUsdc(op.asset)) reject(`${where}: asset is ${assetLabel(op.asset)}, expected official USDC`);
        if (flow === 'transfer') {
          if (op.destination !== expect.destination) {
            reject(`${where}: pays ${op.destination}, expected ${expect.destination}`);
          }
          if (!sameAmount(op.amount, expect.amount)) {
            reject(`${where}: pays ${op.amount}, expected ${expect.amount}`);
          }
        } else if (flow === 'claim') {
          // The claim fee is settled as a USDC payment back to Rozo custody.
          // Pin BOTH ends of it: the amount may not exceed the fee you were
          // quoted, and it has to go to custody rather than wherever the server
          // fancies.
          if (op.destination !== ROZO_CUSTODY) {
            reject(`${where}: pays the claim fee to ${op.destination}, expected Rozo custody ${ROZO_CUSTODY}`);
          }
          const cap = Number(expect.maxSelfPayment);
          if (!Number.isFinite(cap)) {
            reject(`${where}: unexpected outgoing payment (no usable quoted fee: ${JSON.stringify(expect.maxSelfPayment)})`);
          }
          if (!Number.isFinite(Number(op.amount)) || stroops(op.amount) > stroops(cap)) {
            reject(`${where}: pays ${op.amount} USDC, more than the quoted fee ${expect.maxSelfPayment}`);
          }
        } else {
          reject(`${where}: unexpected outgoing payment in a ${flow} transaction`);
        }
        break;
      }
      case 'accountMerge': {
        if (flow !== 'close') reject(`${where}: account merge is only expected in the close flow`);
        if (op.destination !== expect.mergeDestination) {
          reject(`${where}: merges into ${op.destination}, expected ${expect.mergeDestination}`);
        }
        break;
      }
      case 'changeTrust': {
        if (!isOfficialUsdc(op.line)) reject(`${where}: trustline is ${assetLabel(op.line)}, expected official USDC`);
        if (flow === 'close' && Number(op.limit) !== 0) {
          reject(`${where}: close must remove the trustline (limit 0), got limit ${op.limit}`);
        }
        break;
      }
      case 'createAccount': {
        if (op.destination !== self) reject(`${where}: funds ${op.destination}, expected your own account`);
        break;
      }
      case 'claimClaimableBalance': {
        if (flow !== 'claim') reject(`${where}: claiming a balance is only expected in the claim flow`);
        if (expect.claimableBalanceId && op.balanceId !== expect.claimableBalanceId) {
          reject(`${where}: claims ${op.balanceId}, expected ${expect.claimableBalanceId}`);
        }
        break;
      }
      case 'beginSponsoringFutureReserves': {
        if (op.sponsoredId !== self) reject(`${where}: sponsors ${op.sponsoredId}, expected your own account`);
        break;
      }
      default:
        break; // endSponsoring / revoke* carry nothing that can move your funds
    }
  }

  // One account gets created and sponsored per flow. A pile of them would each
  // lock base reserves on whatever account sourced them.
  for (const type of ['createAccount', 'beginSponsoringFutureReserves']) {
    const n = foreign.filter((t) => t === type).length + ours.filter((t) => t === type).length;
    if (n > 1) reject(`transaction contains ${n} ${type} operations, expected at most one`);
  }
  if (!ours.length) reject('none of the operations are yours to sign — refusing to hand over a signature');
  // Each flow moves your money exactly once: the defining operation has to be
  // there (or you are signing something that is not the flow you asked for) and
  // it has to be there only once (a second payment or merge you source would
  // pass the per-operation checks individually while doubling what leaves your
  // account).
  const REQUIRED = { claim: 'claimClaimableBalance', transfer: 'payment', close: 'accountMerge' };
  const required = REQUIRED[flow];
  if (!required) reject(`unknown flow ${JSON.stringify(flow)}`);
  for (const type of ['payment', 'accountMerge', 'claimClaimableBalance']) {
    const n = ours.filter((t) => t === type).length;
    if (n > 1) reject(`transaction contains ${n} ${type} operations sourced by you, expected at most one`);
    if (type === required && n !== 1) {
      reject(`a ${flow} transaction must contain exactly one ${required} operation sourced by you, found ${n}`);
    }
  }
  console.log(`xdr verified: ${tx.operations.length} ops, yours: ${ours.join(', ')}`);
  return tx;
}

export { XdrRejected };
