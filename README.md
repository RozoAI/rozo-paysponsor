# rozo-paysponsor

**Sponsored onboarding for brand-new Stellar wallets.** Deliver USDC to a wallet
that holds **0 XLM and no trustline**, and let its owner claim it **paying zero
gas** — reference scripts plus a hardened client-side transaction guard, driven
entirely by public APIs, no frontend required.

New Stellar accounts face a hard onboarding cliff: an account needs XLM reserves
before it can exist, and a USDC trustline can only be authorized by the
recipient's own signature. This repository documents and implements a working
answer to that cliff — the reserve sponsorship, the two-phase claim, the
anti-faucet gate, and the reserve rebate on close — as reproducible scripts you
can run against production yourself.

📖 **[WALKTHROUGH.md](WALKTHROUGH.md)** — illustrated, step-by-step record of a
real production run (bridge → claim → close → rebate) with on-chain explorer
screenshots and verifiable transaction hashes.

Supported sources: **any Intents source chain → Stellar**, including
**Stellar → Stellar**. (CCTP is an internal transport detail on some routes,
not a separate product rail.)

- **License:** Apache-2.0 · **Status:** running against production
- **Maintainers & how to contribute:** [MAINTAINERS.md](MAINTAINERS.md) ·
  [CONTRIBUTING.md](CONTRIBUTING.md)

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

## Product rules

| Rule | Value |
|---|---|
| Opt-in | Sponsorship is per-intent: pass the `intent` field at creation (frontend passes `?intent=stellarsponsor`). No field → no sponsorship, normal behavior. |
| Amount range | **$0.01 – $100 net per sponsored payout**, enforced at creation. Need more headroom? See [Limits and `appId`](#limits-and-appid) below. |
| `appId` | Every intent carries an `appId`. The scripts default to the public test id **`rozoTest`** — no signup, no API key, enough to run everything here. Your own registered appId travels with its API key (`X-API-Key`). |
| Routes | Any Intents source chain → Stellar, **including Stellar → Stellar**. |
| Bridge / transfer fee | **0.1 % of the amount, minimum $0.01** (so a $1 order pays $0.01). Charged whether or not sponsorship applies. |
| Already has a USDC trustline | **No claim fee at all** — the payout is delivered straight to the wallet, no claimable balance, no sponsorship. Only the bridge/transfer fee applies. |
| Claim fee | **$0.05 plus 2 XLM** (the sponsored-reserve deposit component, converted to USD at quote time), **ceiled to the next whole cent**, deducted from the delivered USDC (a fresh wallet has nothing else to pay with). Example at XLM = $0.175: 2 × 0.175 + 0.05 = 0.40 → fee **$0.40**, so a $0.99 claimable balance nets exactly **$0.59**. The 2 XLM is effectively a deposit — most of it comes back on account close. |
| Close | Two variants. **`close`** (no balance): delete the account; unlocked XLM reserves are rebated **in USDC only** (95%, priced at execution time), paid asynchronously from custody. **`close with balance`**: the remaining USDC is swept out first, then the account is merged, and the reserve rebate follows separately. A destination is required. The `close-intents.mjs` script in this repo implements the **Stellar (`G…`) destination** only — a Base (`0x…`) destination needs an extra bridge leg that the script does not do. Zero gas throughout. |
| Park TTL | 30 days; expiry releases sponsorship capacity but funds stay on the custody ledger and remain claimable on request. |

### Limits and `appId`

The scripts run against public production endpoints with `appId: "rozoTest"` — a
shared test identifier. No signup, no API key, no allowlisting. Runs made with
it are excluded from our production statistics.

`rozoTest` is subject to the standard sponsored range of **$0.01 – $100 net per
payout**, which is plenty to reproduce every step in the walkthrough. Outside
that range the dry run tells you before anything is spent:

- above it → `stellar_sponsor_amount_above_current_limit`
- below the bridge fee → `amountTooLow` / `FEE_EXCEEDS_AMOUNT`

For a higher limit, or for anything you intend to ship, register your own
application at **<https://partners.rozo.ai>**, choosing the **wallet**
application type. You receive an `appId` and an API key, and they are used **as
a pair** — a registered appId sent without its key is rejected with
`400 missing_api_key`. Put both in your `.env`:

```bash
APP_ID=wallet_your_app_id
ROZO_API_KEY=your_api_key
```

`deposit-intents.mjs` reads both from the environment, sends the key as an
`X-API-Key` header, and falls back to `rozoTest` with no key when `APP_ID` is
unset. If you set a registered `APP_ID` without `ROZO_API_KEY` it stops
immediately and tells you, rather than letting the API reject the create.

> **What is live today.** Everything the scripts in this repo call — the dry-run
> quote, intent creation, the sponsored claim endpoints, and the account-close
> and transfer endpoints — is deployed on the production base URL below, and the
> [walkthrough](WALKTHROUGH.md) is a real production run against it. Two caveats
> for anyone reading the tables above as a spec rather than as a script:
> the reserve rebate is paid **asynchronously** by a background worker and can
> lag the close by hours, and closing to a **Base (`0x…`) destination** is a
> product capability that `close-intents.mjs` does not implement. Sponsorship
> also depends on live custody capacity; if it is exhausted the build call
> returns `503 sponsorship_capacity_exhausted` and nothing is spent.

## API surface

Base: `https://intentapiv4.rozo.ai/functions/v1/payment-api`

| Step | Endpoint |
|---|---|
| Fee quote (dry run) | `POST /payments?dryrun=true` — same body as create (no `orderId` needed); creates nothing, spends nothing. For `intent: "stellarsponsor"` the response carries `stellarSponsor: {mode, sponsorFee, netAmount, claimableBalanceAmount, totalFee, xlmUsdPrice}` from the exact same quote path the real create freezes. `mode: "direct"` means the destination already has the trustline (no sponsorship, no fee). |
| Create intent | `POST /payments` — add an `X-API-Key` header if `appId` is your own registered id. Body: `{appId, orderId, type: "exactIn", intent: "stellarsponsor", source: {chainId, tokenSymbol: "USDC", amount}, destination: {chainId: "1500", tokenSymbol: "USDC", receiverAddress: "G..."}}` → `source.receiverAddress` is the deposit address (source chainId `8453` = Base, `1500` = Stellar, …) |
| Payment status | `GET /payments/:id` |
| Claim status | `GET /payments/:id/claim` |
| Build sponsored claim | `POST /payments/:id/claim/transaction` — body `{claimant: "G..."}`, `Idempotency-Key` header (8–200 chars) |
| Submit signed XDR | `POST /payments/:id/claim/submit` — body `{transactionId, signedXdr}`, `Idempotency-Key` header |
| Sponsored transfer | `POST /stellar/transfers/transaction` — body `{sourceAddress, destination, asset: "USDC", amount}`, `Idempotency-Key` header → sign locally → `POST /stellar/transfers/submit` |
| Close account | `POST /stellar/accounts/close/preflight` → `POST /stellar/accounts/close/transaction` — body `{address, mergeDestination}`, `Idempotency-Key` header → sign locally → `POST /stellar/accounts/close/submit` |

## Scripts

All scripts read secrets from environment variables or local `wallets/` files
(0600, gitignored) — never CLI arguments, never committed.

```bash
npm install                                # Node 20+
cp .env.example .env                       # fill in DEPOSIT_EVM_PRIVATE_KEY (never commit .env)
                                           # optional: APP_ID (defaults to rozoTest)
# fund that Base wallet first: >= the USDC you want to send (1 USDC is enough)
# plus ~0.0002 ETH for gas. A 1 USDC run delivers 0.59 USDC to the fresh
# wallet, and ~0.16 more comes back if you close the account afterwards.

# 1. fresh recipient wallet
node scripts/create-wallet.mjs stellar     # → wallets/stellar-<ts>.txt

# 2. deposit — prints the quote first, then spends real money
export DEPOSIT_EVM_PRIVATE_KEY=0x...       # funded Base wallet (USDC + gas ETH)
node scripts/deposit-intents.mjs --amount 1

# 3. claim — recipient side, zero gas
node scripts/claim-intents.mjs             # payment id auto-read from wallets/

# 4. optional: close the account and get the reserve deposit back
#    --destination must be a DIFFERENT, already-existing Stellar account that
#    already holds the official USDC trustline (see below)
node scripts/close-intents.mjs --destination G...
```

**Preparing the close destination.** Step 4 sweeps the USDC, merges the account
away and receives the reserve rebate — all into a Stellar account that must
already exist and already trust the official USDC issuer
(`GA5ZSEJY…RE34K4KZVN`). The wallet created in step 1 does not qualify: it is the
account being closed, and it only exists at all because Rozo sponsored it. The
script checks both conditions up front and refuses rather than merging into a
dead end. Three ways to get a valid destination:

- **A Stellar wallet you already use** (Lobstr, Freighter, Solar…): create the
  account if it is new (it needs ~1 XLM of reserve, e.g. bought on an exchange
  and withdrawn), then add the USDC asset in the wallet UI — that is the
  `changeTrust` operation the sweep needs.
- **An exchange deposit address that supports Stellar USDC** (Kraken, Binance…):
  these already have the trustline. ⚠️ Most exchange addresses are shared and
  require a **memo** to credit your account — this script sends no memo, so the
  funds may be unattributed or lost. Only use one if your exchange gives you a
  dedicated, memo-less Stellar deposit address.
- **A second throwaway wallet**: `node scripts/create-wallet.mjs stellar`, run the
  deposit + claim legs against it once (that is what creates the account and its
  USDC trustline), then use it as the destination for the first wallet's close.

`deposit-intents.mjs` always prints the dry-run quote (fee and net amount)
before it creates or funds anything, and aborts if the API cannot produce a
sponsorship quote — no quote means no known fee and no proof this deployment can
serve the claim, so funding it would risk parking money with no way out.
(`--i-understand-there-is-no-quote` overrides that abort and proceeds anyway; the
claim step will then need an explicit `--max-fee`.) There is no separate
quote-only invocation: running the script always ends in a real payment.

### Signing safety

Both signing scripts verify the transaction the API returns **before** the key
touches it (`scripts/xdr-guard.mjs`): public network passphrase, an allowlist of
operation types, and — for every operation your signature would authorize — the
account, asset issuer, destination and amount you actually asked for. A wrong
`INTENTS_API`, or a compromised one, therefore cannot collect your signature on
a payment, a signer change or an account merge you did not request; the script
aborts and nothing is signed or spent. Specifically it also:

- normalizes muxed (`M…`) addresses to their base `G…` account before every
  comparison, so an operation cannot be disguised as somebody else's to escape
  the field checks;
- refuses any transaction whose **fee** you would pay — these flows are
  sponsor-paid end to end, so that is a wrong transaction, not a price change —
  and bounds the sponsor's own fee too (1 XLM), including a fee-bump wrapper's;
- refuses operations sourced by an account that is not yours unless they are
  pure sponsorship plumbing, and requires even that plumbing to point at your
  account (a sponsorship or account creation aimed elsewhere would lock reserves
  on the account that sourced it) and to appear at most once;
- requires the operation the flow is actually for (claim → one
  `claimClaimableBalance`, transfer → one `payment`, close → one `accountMerge`)
  to be present exactly once, so a transaction can neither omit what you asked
  for nor double it;
- compares destinations exactly, so a muxed alias of the right base account
  cannot silently change who gets credited, and pins the claim fee's recipient
  to Rozo custody (`GBLTI2TT…ADWMXUAE`, override with `ROZO_CUSTODY_ADDRESS` if
  you run your own deployment) rather than letting the server name it.

**The one assumption it cannot check for you:** the guard classifies an
operation as "not yours, so your signature adds nothing" by looking at its
source account. That is only true if your signing key is not a registered signer
on that other account. It holds by construction here — `create-wallet.mjs`
generates a fresh, single-purpose key that is a signer on nothing else — so
**run these scripts with a dedicated key, not with a key that co-signs other
Stellar accounts.** If you must, set `ROZO_SPONSOR_ADDRESSES=G...,G...` to pin
the accounts Rozo may source and fee-pay from; the guard then rejects anything
sourced elsewhere. It is unset by default because production rotates through a
pool of fee payers (one recorded run used three different ones), so a
hard-coded pin would reject good transactions the day the pool changes.

The claim fee is settled as a USDC payment from you to Rozo custody inside the
claim transaction, so the guard needs a ceiling for it — and that ceiling must
not come from the server that builds the transaction. `deposit-intents.mjs`
writes the fee you accepted to `wallets/<paymentId>.quote.json` (gitignored, no
secrets), and `claim-intents.mjs` refuses to sign if the API later quotes more
than that. Those are the only two accepted sources of the ceiling — the frozen
quote and `--max-fee <amount>`. With neither (claiming a payment deposited from
another machine, say), no ceiling is passed to the guard at all and any outgoing
payment is refused: re-run with `--max-fee` once you have decided what you will
pay. The live `sponsorFee` from the API is displayed, never trusted as the cap.

The claim script retries the known `submit_rejected` / `tx_too_early` flake
(build sets minTime = now; a submit within the same ledger can be early) by
resubmitting the same ticket after ~8s.

## Test plan (documented first, then run)

Each full run costs ~$1 USDC + Base gas and exercises production. All numbers
below assume XLM ≈ $0.175; your quote will differ slightly with spot price.

| # | Step | Expected |
|---|---|---|
| 1 | `create-wallet.mjs stellar` | new G address; account does NOT exist on Horizon |
| 2 | `deposit-intents.mjs --amount 1` | dryrun quote printed first (fee $0.40, net $0.59 on a $0.99 claimable balance); intent created (with `intent: stellarsponsor`); deposit address returned; Base tx confirmed; claim appears (parked) within a few minutes |
| 3 | `GET /payments/:id/claim` | claim exists, status `claim_ready`, amount `0.99` |
| 4 | `claim-intents.mjs` | build returns signable XDR; submit 200 (allow one 422 retry); tx on Horizon |
| 5 | Wait ≤2 min | claim terminal; Horizon shows the official-issuer USDC on the new wallet, **minus the cent-ceiled 2 XLM + $0.05 fee** — a whole-cent net, e.g. exactly 0.5900000 |
| 6 | Re-run `claim-intents.mjs` | idempotent: no double-spend, no error loop |
| 7 | Stellar→Stellar variant of 2–6 | same outcome with source chainId `1500` |
| 8 | Create with a net amount above $100 | rejected at creation |
| 9 | `close-intents.mjs --destination G…` after a claim | leg 1 sweeps the USDC to the destination, leg 2 merges the account away (source 404 on Horizon); the 95 % reserve rebate arrives from custody afterwards — possibly hours later |

Failure triage:
- build 503 `sponsorship_capacity_exhausted` → custody sponsorship capacity is exhausted; nothing was spent, retry later
- submit 422 twice+ → the `tx_too_early` flake; the scripts already retry the same ticket, a persistent 422 means the ticket expired — rebuild
- close leg 2 blocked → source still holds USDC or another trustline; leg 1 must reach a zero USDC balance first

## Secret scanning

Enable the local gitleaks pre-commit hook once per clone: `brew install gitleaks pre-commit && pre-commit install` (config in `.pre-commit-config.yaml`). CI also runs a report-only scan in `.github/workflows/secret-scan.yml`.
