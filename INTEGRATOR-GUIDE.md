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

## 2. Step 0: fetch and PIN the platform config (both sides, at sign time)

Before doing anything, fetch the platform's current on-chain accounts and
**pin them against a locally compiled allowlist**. The config tells you who the
gas sponsor, claim custody, and transaction-channel accounts are — but a
compromised API could serve you a wrong list, so the config response itself is
never trusted blindly.

```
GET /stellar/config?network=public
```

**Response shape:**

```json
{
  "network": "public",
  "networkPassphrase": "Public Global Stellar Network ; September 2015",
  "officialUsdc": { "code": "USDC", "issuer": "GA5ZSEJY…" },
  "platformAccounts": {
    "gasSponsors": ["GCW5VQ32…"],
    "claimCustodies": ["GBLTI2TT…"],
    "claimChannels": ["GB4EDWTT…", "GDRLDKM…", "GB52UAWS…"]
  }
}
```

**Pins (Phase 0 allowlist, from the production frontend):**

| Role | Address | Source |
|---|---|---|
| Gas sponsor | `GCW5VQ32URMOM2D3PY2Y5KEEOKTTFWATVSZ2IVHWWHYGAMHIG2M56E6U` | `STELLAR_PHASE0_GAS_SPONSOR` |
| Claim custody | `GBLTI2TTQXUAYNKGCQ63YA55KTFEAOQJ3DPBPELNPWCJVE76ADWMXUAE` | `STELLAR_PHASE0_CLAIM_CUSTODY` |
| Claim channels | `GB4EDWTTIOLYJZHCB3GIOG2TEVF2TF3YES2MDP2S3J7BQWCTCNHAN44A`, `GDRLDKMRO2B2CDZ6YZIMQWFTG5CR6LSKNCFQW7MZG37Q72FDSYF4O2FW`, `GB52UAWSQOTBP4SOMRAHSJEAKQN6G3UP753HKH7A2Q74BPSNTUU54543` | `STELLAR_PHASE0_CLAIM_CHANNELS` |
| USDC issuer | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | `STELLAR_PUBLIC_USDC_ISSUER` |

These accounts are rotated via KMS — the pins in your client must be updated
whenever Rozo rotates them (the frontend's pins carry rotation comments).

**Why pin:** the claim XDR will be sourced by one of the `claimChannels`, the
sponsorship by a `gasSponsor`, and the fee payment will go to `claimCustody`.
Pinning all three means a malicious server cannot redirect the fee or source
the transaction from an account it controls.

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
    "receiverAddress": "0xa443f34ef6cb4aef4107ebc11ca214238f8FE60a"
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
`claimableBalanceId`, the recipient can claim. The claim status lifecycle:
`waiting_payin` → `funding` → `bridging` → `claim_ready` (claimable) →
`submitted` → `claim_completed` (terminal). Failure states (`failed`,
`expired`, `recovered`) are possible at every stage — see Error handling.

### Step 3: Preflight the claim (recipient side)

Before building anything, re-check the claim status — it must still be
`claim_ready` (a claim can expire or be recovered while you wait):

```
GET /payments/:id/claim
```

The response carries `claimableBalanceId`, `sponsorFee`, `netAmount`, and the
`claimant` — the signing guard compares the built transaction against these.

For a richer preflight, `GET /stellar/accounts/:address/status` reports the
recipient's on-chain state (account exists? single-signature? USDC trustline?
balances?). The reference scripts refuse to proceed unless the account is a
brand-new single-signature wallet whose key signs for nothing else.

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
  "transactionHash": "287c03ceab932849d8556fd94e8748de30f84dfa58d05879e24c0c0956c33654",
  "expiresAt": "2026-08-13T12:00:00Z",
  "summary": {
    "transactionSource": "GB4EDWTT...",
    "operations": ["claimClaimableBalance", "payment"]
  }
}
```

> **Note:** a build is a single-use ticket. The backend rejects a second build
> for the same payment with `claim_xdr_already_active` while the first is still
> active. The frontend persists its last build locally and reuses it until it
> expires — port that pattern so a user retry doesn't hit the error.

### Step 5: Verify the XDR before signing (recipient side — critical)

**This is the most important step.** Before signing the XDR, the recipient
**must** verify that the transaction does what they expect. The server
returned the XDR, and a compromised or misconfigured server could return a
transaction that spends funds elsewhere.

**What to verify (the checks `scripts/xdr-guard.mjs` enforces):**

| Check | Why |
|---|---|
| Network passphrase is `Public Global Stellar Network ; September 2015` | Prevents testnet transactions from being signed |
| The XDR parses, is unsigned, and its hash matches `build.transactionHash` | The envelope is exactly what the server said it built |
| Transaction source is a Rozo sponsor (allowlisted, or from `ROZO_SPONSOR_ADDRESSES`) | The fee payer is a Rozo platform account, not an attacker |
| No fee-bump, no Soroban envelope, no memo, no extra preconditions | The transaction is the simple classic shape expected |
| Timebounds: valid now, expires in 2–5 minutes, within the API's `expiresAt` | No replayed/expired/stale transaction |
| Fee is within the safety limit (~100 stroops/op to 10,000/op) | Bounds the sponsor's fee; a fee *you* would pay is refused |
| Operation count and types match `build.summary.operations` | Nothing added, nothing removed |
| The claim operation sequence is one of the allowed shapes | See below |
| The fee `payment` is the last operation, goes to pinned `claimCustody`, and its amount **exactly equals** `claim.sponsorFee` | No fee inflation, no redirect |

**Allowed claim operation sequences** (exactly one of these):

```
claimClaimableBalance → payment
beginSponsoringFutureReserves → changeTrust → endSponsoringFutureReserves
    → claimClaimableBalance → payment
beginSponsoringFutureReserves → createAccount → changeTrust
    → endSponsoringFutureReserves → claimClaimableBalance → payment
```

Each operation must additionally check:

- `beginSponsoringFutureReserves`: sourced by an allowlisted gas sponsor,
  `sponsoredId` is your address
- `createAccount`: sourced by a gas sponsor, destination is you, starting
  balance **0 XLM**
- `changeTrust`: sourced by you, asset is official USDC, limit ≥ claimable
  balance amount
- `claimClaimableBalance`: sourced by you, `balanceId` ===
  `claim.claimableBalanceId`
- `payment`: sourced by you, destination is pinned custody, asset is official
  USDC, amount === `claim.sponsorFee` (max 2 XLM equivalent)
- `endSponsoringFutureReserves`: sourced by you

**The reference implementation** is `scripts/xdr-guard.mjs` in this repo, used
by `claim-intents.mjs` and `close-intents.mjs`. Port it or implement equivalent
checks with your Stellar SDK.

### Step 6: Sign and submit

After verification, sign the XDR with the recipient's wallet and submit. In a
web wallet, this is a single popup to the user:

```javascript
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

const kp = Keypair.fromSecret(recipientSecret);
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
  "transactionHash": "287c03ceab932849d8556fd94e8748de30f84dfa58d05879e24c0c0956c33654"
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

### Step 9 (wallet-first variant): look up claims by address

If your app shows a user "you have money waiting" without knowing a payment ID,
there is a wallet-first lookup surface:

```
GET /stellar/accounts/:address/cctp-unclaimed
```

Returns pending deliveries bound for that address. When one exists and the
address lacks a USDC trustline, the app can build a **sponsored trustline
setup** (no claimable balance involved — just the trustline):

```
POST /stellar/accounts/:address/sponsor-trustline/transaction   # body: { address }
POST /stellar/accounts/:address/sponsor-trustline/submit        # body: { transactionId, signedXdr }
```

**Trustline XDR expectations:** no `payment` or `accountMerge` may appear (the
template moves no value — an injected payment is a tamper). Exactly one of:

```
beginSponsoringFutureReserves → changeTrust → endSponsoringFutureReserves
beginSponsoringFutureReserves → createAccount → changeTrust → endSponsoringFutureReserves
```

`beginSponsoringFutureReserves` sourced by an allowlisted gas sponsor
targeting your address; `changeTrust` sourced by you for official USDC with a
positive limit.

---

## 4. API reference

**Production base URL:** `https://intentapiv4.rozo.ai/functions/v1/payment-api`

### Endpoints

| Step | Method | Endpoint | Auth | Notes |
|---|---|---|---|---|
| Platform config | `GET` | `/stellar/config?network=public` | — | Pin against local allowlist |
| Fee quote | `POST` | `/payments?dryrun=true` | `X-API-Key` (if registered) | Same body as create, no `orderId` needed |
| Create intent | `POST` | `/payments` | `X-API-Key` (if registered) | Sets `intent: "stellarsponsor"` |
| Payment status | `GET` | `/payments/:id` | — | Returns current state |
| Claim status | `GET` | `/payments/:id/claim` | — | Poll until `status: "claim_ready"` |
| Account status | `GET` | `/stellar/accounts/:address/status` | — | Preflight for claim/close |
| Build claim | `POST` | `/payments/:id/claim/transaction` | `Idempotency-Key` | Returns unsigned XDR |
| Submit claim | `POST` | `/payments/:id/claim/submit` | `Idempotency-Key` | Submit signed XDR |
| Wallet-first lookup | `GET` | `/stellar/accounts/:address/cctp-unclaimed` | — | Pending deliveries by address |
| Build trustline | `POST` | `/stellar/accounts/:address/sponsor-trustline/transaction` | `Idempotency-Key` | Trustline setup |
| Submit trustline | `POST` | `/stellar/accounts/:address/sponsor-trustline/submit` | `Idempotency-Key` | |
| Build transfer | `POST` | `/stellar/transfers/transaction` | `Idempotency-Key` | Close leg 1 |
| Submit transfer | `POST` | `/stellar/transfers/submit` | `Idempotency-Key` | |
| Close preflight | `POST` | `/stellar/accounts/close/preflight` | `Idempotency-Key` | Checks eligibility |
| Build close | `POST` | `/stellar/accounts/close/transaction` | `Idempotency-Key` | Close leg 2 |
| Submit close | `POST` | `/stellar/accounts/close/submit` | `Idempotency-Key` | |

### Headers

| Header | When | Value |
|---|---|---|
| `X-API-Key` | Create/quote with registered `appId` | Your API key from partners.rozo.ai |
| `Idempotency-Key` | All POST build/submit endpoints | UUID (8–200 chars) |

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
| Reserve rebate (95% of 1 XLM + $0.05) | +$0.16 |
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
| 4xx | `claim_xdr_already_active` | A build for this payment is still active server-side | Wait for the active ticket to expire, then rebuild with a fresh `Idempotency-Key` |
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
  is still active — you'll get `claim_xdr_already_active`.

---

## 7. Security checklist

| Requirement | Why |
|---|---|
| **Fetch `/stellar/config` and pin it at sign time** | A stale or server-invented config could smuggle a bad custody/issuer address in |
| **Verify the XDR before signing** | A compromised API could return a transaction that spends your funds elsewhere |
| **Use a dedicated signing key** | If your key is a signer on other accounts, its signature on foreign-sourced operations could authorize unintended actions |
| **Freeze the quoted fee at deposit time** | The `sponsorFee` from the deposit quote is the ceiling — never trust the server's live fee as a cap |
| **Never commit secrets** | `.env` and `wallets/` are gitignored; scripts read from env or local files, never CLI args |
| **Never paste a secret into an issue or PR** | A transaction hash + description is enough to debug any issue here |
| **Pin the custody address** | The claim fee payment must go to Rozo custody, not wherever the server says |

---

## 8. Integration checklist

- [ ] Register at [partners.rozo.ai](https://partners.rozo.ai) (wallet type)
- [ ] Get `appId` and `X-API-Key`
- [ ] Implement `/stellar/config` fetch + local pinning (copy the Phase 0 allowlist)
- [ ] Implement the deposit flow (create intent → pay deposit address)
- [ ] Implement the claim flow (preflight → build → verify → sign → submit)
- [ ] Port or replicate the `xdr-guard.mjs` checks for your platform
- [ ] Implement the close flow (optional — for reserve rebate)
- [ ] Implement the wallet-first lookup (optional — for "you have money waiting" UI)
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