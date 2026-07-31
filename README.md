# rozo-paysponsor-demo

Script-only demo of **Rozo's gasless sponsored claim**: send USDC to a
**brand-new Stellar wallet** (0 XLM, no trustline) and let the recipient claim
it **paying zero gas** — entirely through public APIs, no frontend.

Two deposit rails, one claim idea:

| Rail | Deposit via | Claim via | Scripts |
|---|---|---|---|
| **Rozo Intents** (primary — our own stack) | Intents API `POST /payments` | `GET/POST /payments/:id/claim*` (sponsored claimable balance) | `deposit-intents.mjs` + `claim-intents.mjs` |
| CCTP bridge (variant — Circle burn/mint) | Bridge API `POST /payments` | `/stellar/accounts/:G/cctp-unclaimed` + `sponsor-trustline/*` | `deposit-cctp.mjs` + `claim-cctp.mjs` |

## Why claiming can never be one-shot (on either rail)

A Stellar trustline can only be authorized by **the recipient's own signature**.
No contract, no relayer, no CCTP mint can create it on the recipient's behalf —
and a brand-new wallet has no XLM to pay for anything itself. So delivery to a
fresh wallet is inherently two-phase:

1. **Deposit**: funds arrive on our side and **park** for the recipient.
2. **Claim**: the recipient signs one transaction locally; Rozo's KMS signer
   co-signs, pays all fees, sponsors the XLM reserves, and delivers the USDC.

The user's only credential is possession of their secret key. The user's only
action is one local signature. Gas paid by the user: zero.

An anti-faucet gate ensures sponsorship is only granted to addresses that
genuinely have funds parked — otherwise the endpoint would be a free XLM
faucet.

## API surface

**Rozo Intents** (base: `https://intentapiv4.rozo.ai/functions/v1/payment-api`)

| Step | Endpoint |
|---|---|
| Create intent | `POST /payments` — `{appId, orderId, type: "exactIn", source: {chainId: "8453", tokenSymbol: "USDC", amount}, destination: {chainId: "1500", tokenSymbol: "USDC", receiverAddress: "G..."}}` → `source.receiverAddress` is the deposit address |
| Payment status | `GET /payments/:id` |
| Claim status | `GET /payments/:id/claim` |
| Build sponsored claim | `POST /payments/:id/claim/transaction` — body `{claimant: "G..."}`, `Idempotency-Key` header (8–200 chars) |
| Submit signed XDR | `POST /payments/:id/claim/submit` — body `{transactionId, signedXdr}`, `Idempotency-Key` header |

**CCTP bridge** (bridge base: `https://api-production-dd86.up.railway.app`)

| Step | Endpoint |
|---|---|
| Create bridge payment | `POST /payments`, notify `POST /payments/:id/payin`, status `GET /payments/:id` |
| List unclaimed | `GET <intents-base>/stellar/accounts/:G/cctp-unclaimed` |
| Build / submit sponsored trustline | `POST <intents-base>/stellar/accounts/:G/sponsor-trustline/{transaction,submit}` (`Idempotency-Key` header) |

> **⚠️ Status 2026-07-31**: all claim endpoints are temporarily **404 in
> production** — the claim code lives on the unmerged `feat/cctp-claim` branch
> of `rozo-intents-api` and the last `payment-api` deploy came from `main`.
> Additionally the intents claim rail needs `STELLAR_GAS_SPONSOR_CLAIM_ENABLED`
> and a provisioned claim-custody account. Deposits still work but park until
> the claim surface is restored. Track: ainative
> `todos/20260729-cctp-claim-canary-handoff.md` and
> `todos/20260731-paysponsor-demo-gaps.md`.

## Scripts

All scripts read secrets from environment variables or local `wallets/` files
(0600, gitignored) — never CLI arguments, never committed.

```bash
npm install                                # Node 20+

# 1. fresh recipient wallet
node scripts/create-wallet.mjs stellar     # → wallets/stellar-<ts>.txt
node scripts/create-wallet.mjs base        # (optional payer wallet)

# 2. deposit — PRIMARY rail (Rozo Intents), spends real money
export DEPOSIT_EVM_PRIVATE_KEY=0x...       # funded Base wallet (USDC + gas ETH)
node scripts/deposit-intents.mjs --amount 1

# 3. claim — recipient side, zero gas
node scripts/claim-intents.mjs             # payment id auto-read from wallets/

# CCTP variant
node scripts/deposit-cctp.mjs --amount 1
node scripts/claim-cctp.mjs
```

Both claim scripts retry the known `submit_rejected` / `tx_too_early` flake
(build sets minTime = now; a submit within the same ledger can be early) by
resubmitting the same ticket after ~8s.

## Test plan (documented first, then run)

Each full run costs ~$1 USDC + Base gas and exercises production.

| # | Step | Expected |
|---|---|---|
| 1 | `create-wallet.mjs stellar` | new G address; account does NOT exist on Horizon |
| 2 | `deposit-intents.mjs --amount 1` | intent created; deposit address returned; Base tx confirmed; claim appears (parked) within ~2 min |
| 3 | `GET /payments/:id/claim` | claim exists, status `claim_ready` |
| 4 | `claim-intents.mjs` | build returns signable XDR; submit 200 (allow one 422 retry); tx visible on Horizon |
| 5 | Wait ≤2 min | claim reaches terminal state; Horizon shows USDC on the new wallet |
| 6 | Re-run `claim-intents.mjs` | idempotent: no double-spend, no error loop |
| 7 | Repeat 2–6 with `*-cctp.mjs` | same outcome via the CCTP rail (`cctp-unclaimed` count 1 → 0) |

Failure triage:
- build 503 `sponsorship_capacity_exhausted` → sponsor flag off (or custody capacity, intents rail)
- 403 `no_pending_cctp_delivery` (CCTP) → deposit hasn't parked yet, or wrong address
- submit 422 twice+ → check Horizon `result_codes` in the signer logs
- claim routes 404 → claim surface not deployed (see status note above)
