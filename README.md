# rozo-paysponsor-demo

Script-only demo of **Rozo's gasless sponsored claim** on the Rozo Intents
rail: send USDC to a **brand-new Stellar wallet** (0 XLM, no trustline) and let
the recipient claim it **paying zero gas** — entirely through public APIs, no
frontend.

Supported sources: **any Intents source chain → Stellar**, including
**Stellar → Stellar**. (CCTP is an internal transport detail on some routes,
not a separate product rail.)

## Why claiming can never be one-shot

A Stellar trustline can only be authorized by **the recipient's own
signature**. No contract, no relayer, no mint can create it on the recipient's
behalf — and a brand-new wallet has no XLM to pay for anything itself. So
delivery to a fresh wallet is inherently two-phase:

1. **Deposit**: funds arrive on our side and **park** for the recipient.
2. **Claim**: the recipient signs one transaction locally; Rozo's KMS signer
   co-signs, pays all fees, sponsors the XLM reserves, and delivers the USDC.

The user's only credential is possession of their secret key. The user's only
action is one local signature. Gas paid by the user: zero.

An anti-faucet gate ensures sponsorship is only granted to addresses that
genuinely have funds parked.

## Product rules (founder-decided 2026-07-29 / 07-31)

| Rule | Value |
|---|---|
| Opt-in | Sponsorship is per-intent: pass the `intent` field at creation (frontend passes `?intent=stellarsponsor`). No field → no sponsorship, normal behavior. |
| Amount cap | **$10,000 USD per sponsored intent**, enforced at creation. |
| Routes | Any Intents source chain → Stellar, **including Stellar → Stellar**. |
| Service fee | **$0.05 flat per operation** — transfer and bridge. |
| Claim fee | **$0.05 plus 2 XLM** (the sponsored-reserve deposit component, converted to USD at claim time), deducted from the delivered USDC (a fresh wallet has nothing else to pay with). At XLM ≈ $0.17: claim ≈ $0.39. The 2 XLM is effectively a deposit — most of it comes back on account close. |
| Close | Two variants. **`close`** (no balance): delete the account; unlocked XLM reserves are rebated **in USDC only** (95%, priced at execution time). **`close with balance`**: remaining USDC plus the reserve rebate are sent out together, with the bridge/transfer fee deducted. Both variants require a destination address — **USDC on Base (`0x…`) or Stellar (`G…`), auto-detected by format**. Zero gas throughout. |
| Park TTL | 30 days; expiry releases sponsorship capacity but funds stay on the custody ledger and remain claimable on request. |

> Server-side status: the claim surface, fee deduction, $10k cap, and
> account-close flow are on the `feat/cctp-claim` branch of `rozo-intents-api`
> (some parts pending implementation). **All claim endpoints are currently 404
> in production** until that branch is merged and redeployed, and the intents
> claim rail additionally needs `STELLAR_GAS_SPONSOR_CLAIM_ENABLED` plus a
> provisioned claim-custody account. Deposits work but park. Track: ainative
> `todos/20260731-paysponsor-demo-gaps.md`.

## API surface

Base: `https://intentapiv4.rozo.ai/functions/v1/payment-api`

| Step | Endpoint |
|---|---|
| Create intent | `POST /payments` — `{appId, orderId, type: "exactIn", intent: "stellarsponsor", source: {chainId, tokenSymbol: "USDC", amount}, destination: {chainId: "1500", tokenSymbol: "USDC", receiverAddress: "G..."}}` → `source.receiverAddress` is the deposit address (source chainId `8453` = Base, `1500` = Stellar, …) |
| Payment status | `GET /payments/:id` |
| Claim status | `GET /payments/:id/claim` |
| Build sponsored claim | `POST /payments/:id/claim/transaction` — body `{claimant: "G..."}`, `Idempotency-Key` header (8–200 chars) |
| Submit signed XDR | `POST /payments/:id/claim/submit` — body `{transactionId, signedXdr}`, `Idempotency-Key` header |
| Close account | account-close endpoints (branch; see `stellar-close-rebate` handlers) |

## Scripts

All scripts read secrets from environment variables or local `wallets/` files
(0600, gitignored) — never CLI arguments, never committed.

```bash
npm install                                # Node 20+
cp .env.example .env                       # fill in DEPOSIT_EVM_PRIVATE_KEY (never commit .env)

# 1. fresh recipient wallet
node scripts/create-wallet.mjs stellar     # → wallets/stellar-<ts>.txt

# 2. deposit — spends real money
export DEPOSIT_EVM_PRIVATE_KEY=0x...       # funded Base wallet (USDC + gas ETH)
node scripts/deposit-intents.mjs --amount 1

# 3. claim — recipient side, zero gas
node scripts/claim-intents.mjs             # payment id auto-read from wallets/
```

The claim script retries the known `submit_rejected` / `tx_too_early` flake
(build sets minTime = now; a submit within the same ledger can be early) by
resubmitting the same ticket after ~8s.

## Test plan (documented first, then run)

Each full run costs ~$1 USDC + Base gas and exercises production.

| # | Step | Expected |
|---|---|---|
| 1 | `create-wallet.mjs stellar` | new G address; account does NOT exist on Horizon |
| 2 | `deposit-intents.mjs --amount 1` | intent created (with `intent: stellarsponsor`); deposit address returned; Base tx confirmed; claim appears (parked) within ~2 min |
| 3 | `GET /payments/:id/claim` | claim exists, status `claim_ready` |
| 4 | `claim-intents.mjs` | build returns signable XDR; submit 200 (allow one 422 retry); tx on Horizon |
| 5 | Wait ≤2 min | claim terminal; Horizon shows USDC on the new wallet, **minus the 2 XLM + $0.05 fee** once fee deduction ships |
| 6 | Re-run `claim-intents.mjs` | idempotent: no double-spend, no error loop |
| 7 | Stellar→Stellar variant of 2–6 | same outcome with source chainId `1500` |
| 8 | Create with amount > $10,000 | rejected at creation once the cap ships |
| 9a | `close with balance` → **Base** dest: deposit → claim → close, giving a `0x…` address | account deleted; balance + reserve rebate bridged to Base minus fee |
| 9b | `close with balance` → **Stellar** dest: deposit → claim → close, giving a `G…` address | account deleted; balance + rebate paid on Stellar minus fee |
| 9c | `close` (no balance) → **Base** dest: deposit → claim → spend the USDC out → close | account deleted; only the reserve rebate (95% of unlocked XLM, in USDC) arrives on Base |
| 9d | `close` (no balance) → **Stellar** dest | same as 9c with a `G…` destination |

Failure triage:
- build 503 `sponsorship_capacity_exhausted` → sponsor flag off or custody capacity
- submit 422 twice+ → check Horizon `result_codes` in the signer logs
- claim routes 404 → claim surface not deployed (see status note above)
