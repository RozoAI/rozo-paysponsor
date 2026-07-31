# rozo-paysponsor-demo

Script-only demo of Rozo's **gasless sponsored claim** flow: send USDC from Base
to a **brand-new Stellar wallet** (0 XLM, no trustline, user never pays gas),
entirely through the public APIs — no frontend involved.

```
deposit (Base USDC → bridge)          claim (recipient, zero gas)
────────────────────────────          ───────────────────────────
create payment → deposit address      list unclaimed USDC
send USDC on Base                     request sponsored trustline XDR
notify payin                          sign locally with own key
→ parks as awaiting_trustline         submit → Rozo KMS co-signs, pays gas
                                      → trustline on-chain → USDC delivered
```

Rozo sponsors the XLM reserves + fees via an AWS KMS signer. The recipient's
only credential is possession of their Stellar secret key. An anti-faucet gate
means sponsorship is only granted to addresses that genuinely have USDC parked.

## APIs used

| Step | Endpoint |
|---|---|
| Create bridge payment | `POST https://api-production-dd86.up.railway.app/payments` |
| Notify deposit tx | `POST .../payments/:id/payin` |
| Payment status | `GET .../payments/:id` |
| List unclaimed | `GET https://intentapiv4.rozo.ai/functions/v1/payment-api/stellar/accounts/:G/cctp-unclaimed` |
| Build sponsored trustline | `POST .../stellar/accounts/:G/sponsor-trustline/transaction` (`Idempotency-Key` header, 8–200 chars) |
| Submit signed XDR | `POST .../stellar/accounts/:G/sponsor-trustline/submit` (`Idempotency-Key` header) |

> **⚠️ Status 2026-07-31**: the claim endpoints (`/stellar/accounts/*`) are
> temporarily 404 in production — the claim code lives on the unmerged
> `feat/cctp-claim` branch of `rozo-intents-api` and the last `payment-api`
> deploy came from `main`. The deposit leg still works, but a deposit made now
> parks until the claim surface is redeployed. Track: ainative
> `todos/20260729-cctp-claim-canary-handoff.md`.

## Scripts

All scripts read secrets from environment variables only — never pass keys as
CLI arguments, never commit them.

### 1. `scripts/create-wallet.mjs`

Generates a fresh keypair and writes it to a local file (mode 0600).

```bash
node scripts/create-wallet.mjs stellar   # → wallets/stellar-<ts>.txt (S... secret + G... public)
node scripts/create-wallet.mjs base      # → wallets/base-<ts>.txt (0x private key + address)
```

`wallets/` is gitignored.

### 2. `scripts/deposit.mjs`

Simulates the payer: creates a bridge payment, sends USDC on Base to the
per-payment deposit address, notifies the API, and waits until the delivery
parks (`awaiting_trustline`) for a brand-new recipient.

```bash
export DEPOSIT_EVM_PRIVATE_KEY=0x...        # funded Base wallet (USDC + a little ETH)
node scripts/deposit.mjs --dest G... --amount 1
# or let it use the newest wallets/stellar-*.txt as recipient:
node scripts/deposit.mjs --amount 1
```

Prints the `paymentId` and saves it next to the recipient wallet file.

### 3. `scripts/claim.mjs`

Simulates the recipient claiming with zero gas: lists unclaimed USDC, requests
the sponsored trustline transaction, signs it locally, submits, then verifies
the USDC balance on Horizon.

```bash
export STELLAR_SECRET=S...                  # recipient secret key
node scripts/claim.mjs
# or read the newest wallets/stellar-*.txt automatically:
node scripts/claim.mjs --wallet wallets/stellar-<ts>.txt
```

Handles the known `submit_rejected` / `tx_too_early` flake by retrying the same
ticket after a ledger close.

## Test plan (write-down first, then run)

Each full run costs ~$1 USDC + Base gas and exercises production.

| # | Step | Expected |
|---|---|---|
| 1 | `create-wallet.mjs stellar` | new G address; account does NOT exist on Horizon |
| 2 | `deposit.mjs --amount 1` | payment created; deposit address returned; Base tx confirmed; status reaches `awaiting_trustline` within ~2 min |
| 3 | `GET .../cctp-unclaimed` for the G address | `count: 1`, amount ≈ 0.9987 (after Circle fee) |
| 4 | `claim.mjs` | build returns signable XDR; submit 200 (allow one 422 retry); trustline tx visible on Horizon |
| 5 | Wait ≤2 min | `cctp-unclaimed` count drops to 0; Horizon shows USDC balance on the new wallet |
| 6 | Re-run `claim.mjs` | idempotent: `already_ready` / nothing to claim, no double-spend |

Failure triage:
- build 503 `sponsored_fee_budget_exhausted` → sponsorship flag off server-side
- build 403 `no_pending_cctp_delivery` → deposit hasn't parked yet (or wrong address)
- submit 422 twice+ → check Horizon `result_codes` in the signer logs
- all claim routes 404 → the claim surface isn't deployed (see status note above)

## Setup

```bash
npm install
```

Requires Node 20+.
