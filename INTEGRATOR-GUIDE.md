# Integrator Guide — Sponsored Stellar Onboarding

A wallet or app that wants to **deliver USDC to a brand-new Stellar account** —
one that holds 0 XLM and has no USDC trustline — needs to integrate with
Rozo's sponsored-claim rail. The recipient signs once, pays zero gas, and
receives USDC without ever touching XLM.

This guide explains the **API flow** from the integrator's side: which endpoints
to call, in what order, how the user signing step works, and how to handle
failures.

---

## How it works in one minute

```
You (the payer)               Rozo API               Recipient (Stellar wallet)
    │                           │                            │
    ├── POST /payments ────────►│                            │
    │   (intent: stellarsponsor)│                            │
    │◄── deposit address ───────┤                            │
    │                           │                            │
    ├── transfer USDC ─────────►│   (bridge)                 │
    │   to deposit address      │                            │
    │                           ├── creates claimable ──────►│
    │                           │   balance (parks USDC)     │   (account doesn't exist yet)
    │                           │                            │
    │◄── share payment ID ──────┤                            │
    │      (off-chain)          │                            │
    │                           │                            │
    │                                             GET /payments/:id/claim │
    │                                             ◄──────────┤
    │                                             POST /payments/:id/claim│
    │                                             /transaction ├──► user signs locally
    │                                             ◄──────────┤   (one signature)
    │                                             POST /payments/:id/claim│
    │                                             /submit ───►
    │                                                         │   account created + trustline
    │                                                         │   + claim delivered
    │                                                         │   in one transaction
```

The flow has **two participants**: the payer (who deposits USDC) and the
recipient (who claims it). They can be the same person, or different people,
or different processes on your backend.

---

## 1. Prerequisites

Register your application at **[https://partners.rozo.ai](https://partners.rozo.ai)**
(application type: **wallet**). You receive:

| Credential | Environment variable | Required for |
|---|---|---|
| `appId` (starts with `wallet_` or `merchant`) | `APP_ID` | All API calls |
| API key | `ROZO_API_KEY` | Sent as `X-API-Key` header |

**Without registration** you can use the shared test id `rozoTest` (no API key
needed). Payouts are limited to **$0.01 – $100 net per payout** and runs are
excluded from production statistics. For production, always use your own
registered `appId`.

### API base URL

**Production base URL:** `https://intentapiv4.rozo.ai/functions/v1/payment-api`

All endpoints below are relative to this base.

---

## 2. Step 0: pin the platform accounts (both sides, before signing)

Before signing anything, make sure your integration uses the **correct on-chain
addresses**. The reference guard (`scripts/xdr-guard.mjs`) ships with two
hardcoded pins:

| Role | Address | Environment override |
|---|---|---|
| USDC issuer | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | `USDC_ISSUER` (constant) |
| Claim custody | `GBLTI2TTQXUAYNKGCQ63YA55KTFEAOQJ3DPBPELNPWCJVE76ADWMXUAE` | `ROZO_CUSTODY_ADDRESS` |

**Why pin:** the claim fee is a USDC payment inside the transaction, and it
must go to Rozo custody — not wherever a compromised server might redirect it.

**Sponsor allowlist (optional):** `ROZO_SPONSOR_ADDRESSES=G...,G...` — when
set, the guard rejects any transaction sourced or fee-paid by an account
outside this list. **Empty by default** because production rotates through a
pool of fee payers, and a hard-coded pin would reject valid transactions the
day the pool changes. For your own deployment, pin it. See the README for
the residual assumption.

These accounts are rotated via KMS — update your pins when they change.

---

## 3. The full flow step by step

### Step 1: Create the intent (payer side)

**You** (the payer) create a payment intent with `intent: "stellarsponsor"` to
opt into sponsorship. Without this field, a no-trustline destination is
rejected.

```
POST /payments
Content-Type: application/json
X-API-Key: <your_api_key>         # only if appId is registered

{
  "appId": "wallet_your_app_id",   // or "rozoTest"
  "orderId": "your-unique-id-123", // idempotent on your side
  "type": "exactIn",
  "intent": "stellarsponsor",      // ← opt-in flag
  "source": {
    "chainId": "8453",             // Base (or "1500" for Stellar → Stellar)
    "tokenSymbol": "USDC",
    "amount": "1.00"               // the amount you want to send
  },
  "destination": {
    "chainId": "1500",             // Stellar
    "tokenSymbol": "USDC",
    "receiverAddress": "G..."      // the recipient's Stellar address
  }
}
```

**Response** includes a `source.receiverAddress` — a deposit address on the
source chain. Send USDC to this address via a plain ERC-20 transfer (no
approvals, no contract calls from the payer).

```json
{
  "id": "pay_abc123",
  "status": "payment_unpaid",
  "source": {
    "receiverAddress": "0x0000...0000"
  }
}
```

> **Before depositing — get a quote first.** Call the same endpoint with
> `?dryrun=true` appended (`POST /payments?dryrun=true`) using the identical
> body. It returns the `stellarSponsor` object with the fee breakdown, net
> amount, and mode (`"sponsored"` or `"direct"`), without creating anything or
> spending any money. The quote is the fee you accept — freeze it locally so
> the claim step can verify the server hasn't inflated it later.

### Step 2: Pay the deposit address (payer side)

Send the exact USDC amount to the deposit address from step 1. This is a
standard ERC-20 `transfer` on the source chain (Base).

| Detail | Value |
|---|---|
| Source chain | Base (chainId `8453`) |
| Token | USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |
| Action | ERC-20 `transfer` to `source.receiverAddress` |
| Gas | Standard Base gas (fraction of a cent) |

After the transfer confirms, the Rozo backend bridges the USDC to Stellar and
parks it as a **claimable balance**. Poll the claim status to know when it's
ready:

```
GET /payments/:id/claim
```

When the response returns `status: "claim_ready"` and carries a
`claimableBalanceId`, the recipient can claim. After submit, the claim
status moves through `submitted` to a terminal status:
`claim_completed`, `claim_confirmed`, or `completed`.

### Step 3: Preflight the claim (recipient side)

Before building anything, re-check the claim status — it must still be
`claim_ready` (a claim can expire or be recovered while you wait):

```
GET /payments/:id/claim
```

The response carries `claimableBalanceId`, `sponsorFee`, `netAmount`, and the
`claimant` — the signing guard compares the built transaction against these.

Check the recipient account's on-chain state the same way the reference
scripts do: query Horizon (`GET https://horizon.stellar.org/accounts/G...`)
and confirm the account is brand new or single-signature, and — for the close
flow — that the destination exists and already holds the official USDC
trustline.

### Step 4: Build the sponsored transaction (recipient side)

**The recipient** (or your backend on their behalf) asks the API to build a
sponsored transaction. This is the transaction that creates the Stellar
account, establishes the USDC trustline, and delivers the claimable balance —
all in one atomic operation, with Rozo paying all fees.

```
POST /payments/:id/claim/transaction
Idempotency-Key: <uuid>           // required, 8–200 chars
Content-Type: application/json

{
  "claimant": "G..."              // the recipient's Stellar address
}
```

**Response:**

```json
{
  "transactionId": "tx_abc123",
  "unsignedXdr": "AAAAAgAAA...",   // the Stellar transaction envelope
  "networkPassphrase": "Public Global Stellar Network ; September 2015",
  "network": "public",
  "transactionHash": "287c...000000000000000000000000000000000000",
  "expiresAt": "2026-08-13T12:00:00Z"
}
```

> **Note:** a build is a single-use ticket — a second build for the same
> payment while the first is active is rejected. Persist the built
> transaction locally and reuse it until it expires, so a retry doesn't hit
> the rejection.

### Step 5: Verify the XDR before signing (recipient side — critical)

**This is the most important step.** Before signing the XDR, the recipient
**must** verify that the transaction does what they expect. The server
returned the XDR, and a compromised or misconfigured server could return a
transaction that spends funds elsewhere.

**What the reference guard (`scripts/xdr-guard.mjs`) actually enforces:**

| Check | Why |
|---|---|
| Network passphrase is `Public Global Stellar Network ; September 2015` | Prevents testnet transactions from being signed |
| The XDR parses as a Stellar transaction with at least one operation | An unparseable envelope is a refusal, not a retry |
| The transaction fee is paid by a sponsor, not by you, and is ≤ 1 XLM (10,000,000 stroops, flat total ceiling) | These flows are sponsor-paid; a fee you would pay is a wrong transaction |
| A fee-bump wrapper is checked for who pays its fee, then unwrapped | Fee bumps are allowed; only the fee source must be the sponsor |
| Transaction source is either you or a trusted sponsor | If you set `ROZO_SPONSOR_ADDRESSES`, **only** those accounts may source or fee-pay; empty by default, so configure it for your deployment |
| Operation types are in the flow's allowlist | No setOptions (signer changes), path payments, offers, or clawbacks |
| Every operation your key signs is checked field-by-field (see below) | Nothing added, nothing changed, no surprise destination |
| Operations sourced by another account can only be sponsorship plumbing aimed at your account | Your signature must not authorize anything that spends |
| Exactly one defining operation for your flow (claim → `claimClaimableBalance`, transfer → `payment`, close → `accountMerge`), and at most one of each spending op | The flow does what you asked, exactly once |
| Fee `payment` goes to pinned `claimCustody`, amount ≤ the quoted fee you accepted (a **cap**, not an exact match) | No fee inflation, no redirect |

**Allowed claim operation shapes** (the operations the API builds; the guard
checks each one individually but does not enforce ordering):

```
claimClaimableBalance → payment
beginSponsoringFutureReserves → changeTrust → endSponsoringFutureReserves
    → claimClaimableBalance → payment
beginSponsoringFutureReserves → createAccount → changeTrust
    → endSponsoringFutureReserves → claimClaimableBalance → payment
```

Each operation must additionally check:

- `beginSponsoringFutureReserves`: sourced by a sponsor, `sponsoredId` is your address
- `createAccount`: sourced by a sponsor, destination is you, starting balance **0 XLM**
- `changeTrust`: sourced by you, asset is official USDC (limit checked only for close, where it must be **0**)
- `claimClaimableBalance`: sourced by you, `balanceId` === `claim.claimableBalanceId`
- `payment` (the claim fee): sourced by you, destination is pinned custody, asset is official USDC, amount **≤ the fee you accepted** (from `--max-fee` or the frozen `wallets/<id>.quote.json`) — the live `sponsorFee` from the API is displayed, never trusted as the cap
- `endSponsoringFutureReserves`: sourced by you

> **The fee cap rule is the one protection not to soften.** The ceiling for the
> in-transaction fee payment must come from a local source — the frozen quote
> written at deposit time, or an explicit `--max-fee` — never from the same
> server that builds the XDR. A compromised API could otherwise inflate
> `sponsorFee`, build a matching payment, and the guard would wave it through.

> **Not checked by the reference guard** (verify these yourself if your
> threat model needs them): hash match against `build.transactionHash`,
> signature count, timebounds, memo/preconditions, operation ordering, or
> `changeTrust` limit ≥ claimable amount.

**The reference implementation** is `scripts/xdr-guard.mjs` in this repo, used
by `claim-intents.mjs` and `close-intents.mjs`. Port it or implement equivalent
checks with your Stellar SDK.

### Step 6: Sign and submit

After verification, sign the XDR with the recipient's wallet and submit. In a
web wallet, this is a single popup to the user:

```javascript
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

const unsignedXdr = 'AAAAAgAAA...';      // from the build response
const networkPassphrase = 'Public Global Stellar Network ; September 2015';
const secret = 'S...';                    // from wallets/stellar-*.txt or env

const kp = Keypair.fromSecret(secret);
const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
tx.sign(kp);
const signedXdr = tx.toXDR();
```

The user's secret never leaves their machine. The only operation they perform
is a single local signature.

Then submit:

```
POST /payments/:id/claim/submit
Idempotency-Key: <uuid>           // same key for retries
Content-Type: application/json

{
  "transactionId": "tx_abc123",
  "signedXdr": "AAAAAgAAA..."     // the signed XDR from step 5
}
```

**Response:**

```json
{
  "status": "submitted",
  "transactionHash": "287c...000000000000000000000000000000000000"
}
```

> **Idempotency note:** Submit with the same `Idempotency-Key` on retry. The
> `tx_too_early` flake (build sets `minTime = now`; a submit within the same
> ledger can be early) is safe to retry after ~8 seconds.

### Step 7: Confirm delivery

Poll the claim status until terminal:

```
GET /payments/:id/claim
```

Terminal statuses: `claim_completed`, `claim_confirmed`, `completed`. The claim
script polls every ~6 seconds up to 10 minutes.

Then check the account's official USDC balance on Horizon:

```
GET https://horizon.stellar.org/accounts/G...
```

Match the balance against the `netAmount` from the quote. The difference should
be within rounding tolerance.

### Step 8 (optional): Close the account

If the recipient wants to recover the sponsored XLM reserve deposit (2 XLM,
converted to USDC), the account can be closed. This is two sponsored legs:

1. **Sweep remaining USDC** to a destination account
2. **Merge the account** away (closes it)

```
POST /stellar/transfers/transaction
POST /stellar/accounts/close/preflight
POST /stellar/accounts/close/transaction
```

**The destination must already exist on Horizon and hold the official USDC
trustline** — the reference script checks both up front and refuses rather
than merging into a dead end. It also requires a destination, rejects the
closing account itself, and runs `close/preflight` (response carries
`close.eligible` and `close.blockers`) before building the merge.

Each follows the same build → verify → sign → submit pattern as the claim,
with an `xdr-guard.mjs` flow of `"transfer"` or `"close"`.

**Transfer XDR expectations:** exactly one `payment` operation, sourced by
you, destination is the requested address (a valid `G…`), official USDC, and
the amount matches exactly.

**Close XDR expectations:** exactly two operations in order —
`changeTrust` (sourced by you, official USDC, limit **0** = removing the
trustline) then `accountMerge` (sourced by you, destination is the requested
`mergeDestination`, which must not be the account itself nor a Rozo platform
account).

The reserve rebate (95% of unlocked XLM, converted to USDC at execution price)
is paid **asynchronously** by a background worker from the pinned custody
account — it can arrive minutes or hours later.

---

## 4. API reference

**Production base URL:** `https://intentapiv4.rozo.ai/functions/v1/payment-api`

### Endpoints

| Step | Method | Endpoint | Auth | Notes |
|---|---|---|---|---|
| Fee quote | `POST` | `/payments?dryrun=true` | `X-API-Key` (if registered) | Same body as create, no `orderId` needed |
| Create intent | `POST` | `/payments` | `X-API-Key` (if registered) | Sets `intent: "stellarsponsor"` |
| Payment status | `GET` | `/payments/:id` | — | Returns current state |
| Claim status | `GET` | `/payments/:id/claim` | — | Poll until `status: "claim_ready"` |
| Build claim | `POST` | `/payments/:id/claim/transaction` | `Idempotency-Key` | Body `{claimant: "G..."}`; returns unsigned XDR |
| Submit claim | `POST` | `/payments/:id/claim/submit` | `Idempotency-Key` | Body `{transactionId, signedXdr}` |
| Build transfer | `POST` | `/stellar/transfers/transaction` | `Idempotency-Key` | Body `{sourceAddress, destination, asset: "USDC", amount}` — close leg 1 |
| Submit transfer | `POST` | `/stellar/transfers/submit` | `Idempotency-Key` | Body `{transactionId, signedXdr}` |
| Close preflight | `POST` | `/stellar/accounts/close/preflight` | — | Body `{address, mergeDestination}`; checks `close.eligible` / `close.blockers` |
| Build close | `POST` | `/stellar/accounts/close/transaction` | `Idempotency-Key` | Body `{address, mergeDestination}`; returns unsigned XDR |
| Submit close | `POST` | `/stellar/accounts/close/submit` | `Idempotency-Key` | Body `{transactionId, signedXdr}` |

### Headers

| Header | When | Value |
|---|---|---|
| `X-API-Key` | Create/quote with registered `appId` | Your API key from partners.rozo.ai |
| `Idempotency-Key` | POST build/submit endpoints (claim, transfer, close) | UUID (8–200 chars) |

---

## 5. Fee structure

| Fee | Amount | When |
|---|---|---|
| Bridge/transfer fee | 0.1% of amount, min $0.01 | Every deposit, sponsorship or not |
| Claim fee | $0.05 + 2 XLM (ceiled to whole cent) | Claim to a new wallet (no trustline) |
| Claim fee | $0 | Destination already has USDC trustline |
| Reserve rebate on close | 95% of unlocked XLM, in USDC | Asynchronous, after account close |

### Example: $1.00 deposit, XLM = $0.175

| Line | Amount |
|---|---:|
| You send | $1.00 |
| Bridge fee | −$0.01 |
| Parked as claimable balance | $0.99 |
| Claim fee (2 × $0.175 + $0.05 = $0.40) | −$0.40 |
| **Lands in wallet** | **$0.59** |
| Reserve rebate (95% of unlocked XLM, in USDC) | +$0.16 |
| **Total recovered if closed** | **$0.75** |

Send more and only the claim fee stays flat — it's a fixed reserve deposit, not
a percentage.

---

## 6. Error handling

### Common errors

| HTTP | Error code | Cause | Action |
|---|---|---|---|
| 400 | `missing_api_key` | Registered `appId` sent without `X-API-Key` | Always send the key with a registered appId |
| 400 | `amountTooLow` / `FEE_EXCEEDS_AMOUNT` | Amount below the bridge fee floor | Send at least $0.01 net |
| 400 | `stellar_sponsor_amount_above_current_limit` | Amount above the $100 net ceiling | Use a registered `appId` for higher limits |
| 503 | `sponsorship_capacity_exhausted` | Custody sponsorship pool is full | Retry later; nothing was spent |
| 422 | `tx_too_early` | Transaction submitted before its `minTime` | Retry with the same `Idempotency-Key` after ~8 seconds |
| 422 | (persistent) | Transaction ticket expired | Rebuild by calling POST `/claim/transaction` again |
| 404 | on claim status | No claim for this payment | Check if the destination already has a trustline (direct delivery) |
| 5xx | `horizon_unavailable` | Horizon outage during submit | Retry; the submit may have landed |

### Retry strategy (from the reference scripts)

| Step | Retry pattern |
|---|---|
| Payment status polling | Poll every 5s for up to 45 minutes (parking latency can be ~1–2 min) |
| Claim status polling | Poll every ~6s up to 10 minutes until terminal |
| Claim submit | Same `Idempotency-Key`, wait 8s, retry up to 4 times |
| Close submit | Same `Idempotency-Key`, wait 8s, retry up to 4 times |
| Claim/close build | Rebuild with a fresh `Idempotency-Key` when the ticket expires |
| Close verification | Poll Horizon every ~6s for up to 5 minutes per leg |

### Guarantee boundaries

- **The claim is atomic:** either the account is created, trustline established,
  and USDC delivered — all in one transaction — or none of it happens.
- **The claim is idempotent:** submitting the same signed XDR twice does not
  double-spend. The second submit returns the same status.
- **The rebate is asynchronous:** it is queued at close time and paid on the
  next rebate pass. If it hasn't arrived within 3 minutes, it's not a failure
  — it will arrive later (observed up to 7.5 hours in production).
- **Builds are single-use:** don't rebuild for the same payment while a build
  is still active — a second build is rejected until the first expires.

---

## 7. Security checklist

| Requirement | Why |
|---|---|
| **Pin the USDC issuer and custody addresses** | The guard compares every asset and the fee destination against hardcoded pins — a stale or server-supplied address could redirect funds |
| **Pin the sponsor allowlist for your deployment** | Set `ROZO_SPONSOR_ADDRESSES` so only your allowed accounts can source or fee-pay; empty by default |
| **Verify the XDR before signing** | A compromised API could return a transaction that spends your funds elsewhere |
| **Use a dedicated signing key** | If your key is a signer on other accounts, its signature on foreign-sourced operations could authorize unintended actions |
| **Freeze the quoted fee at deposit time** | The fee you accepted is the ceiling — never trust the server's live `sponsorFee` as a cap |
| **Never commit secrets** | `.env` and `wallets/` are gitignored; scripts read from env or local files, never CLI args |
| **Never paste a secret into an issue or PR** | A transaction hash + description is enough to debug any issue here |
| **Pin the custody address** | The claim fee payment must go to Rozo custody, not wherever the server says |

---

## 8. Integration checklist

- [ ] Register at [partners.rozo.ai](https://partners.rozo.ai) (wallet type)
- [ ] Get `appId` and `X-API-Key`
- [ ] Pin the USDC issuer + custody addresses, and set `ROZO_SPONSOR_ADDRESSES` for your deployment
- [ ] Implement the deposit flow (create intent → pay deposit address)
- [ ] Implement the claim flow (preflight → build → verify → sign → submit)
- [ ] Port or replicate the `xdr-guard.mjs` checks for your platform
- [ ] Implement the close flow (optional — for reserve rebate)
- [ ] Test with the shared `rozoTest` id first
- [ ] Switch to your registered `appId` + API key for production
- [ ] Subscribe to the [Rozo changelog](https://partners.rozo.ai) for API updates
- [ ] Track the pinned platform accounts — they rotate via KMS

---

## See also

- [WALKTHROUGH.md](WALKTHROUGH.md) — a complete, recorded production run with
  transaction hashes and explorer links
- [README.md](README.md) — product rules, limits, and script reference
- `scripts/xdr-guard.mjs` — the reference signing guard
