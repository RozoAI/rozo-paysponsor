# Production Walkthrough — bridge → claim → close → rebate

A real, end-to-end run of the sponsored-claim rail on **production**, executed
2026-07-31 / 08-01 with real money. Every hash below is verifiable on a public
explorer. All addresses shown are our own test wallets.

**The run in one line:** $1 USDC left a Base wallet, arrived as a claimable
balance for a brand-new Stellar account that held **0 XLM for its entire
life**, was claimed with a single local signature, spent out, and the account
was then closed — with the sponsored XLM reserves rebated back **in USDC**.
The recipient never touched XLM and never paid gas.

> **Fee note:** this run executed under the old 7-decimal-place fee formula
> (fee 0.3890080, net 0.6009920 on a $0.99 park). Under the current
> whole-cent-ceiling rule the same order quotes
> **fee $0.40 / net $0.59**. The quote example in step 1 shows today's
> numbers; the on-chain records show the historical 7dp amounts.

Cast:

| Role | Address |
|---|---|
| Recipient (fresh Stellar wallet, 0 XLM, later merged away) | `GCWV4GABBFLD5GWBILJVHQS75A5DWBRTL2I6JX7J3T3TQ5QZYPKF2L6N` |
| Source (Base wallet) | `0xee0C209491EAFb57769D6504e05a49BF8987A5e3` |
| Intent deposit address (Base) | `0xa443f34ef6cb4aef4107ebc11ca214238f8FE60a` |
| Close destination (Stellar) | `GD5R4HTO5Y22ZNBD2ZZDJHFYN5JDYHDHG3VINLPM2ZU7HCIHUMI2BB4U` |
| Rozo claim custody | `GBLTI2TTQXUAYNKGCQ63YA55KTFEAOQJ3DPBPELNPWCJVE76ADWMXUAE` |

---

## 0. Run it yourself — setup

You need Node 20+, about five minutes, and a Base wallet funded with:

- **USDC**: the amount you want to send — 1 USDC is enough for a full run
- **ETH**: ~0.0002 ETH, which covers a few hundred deposits (one costs well
  under a cent of gas)

Everything below talks to public production endpoints; no API key, no
allowlisting, no account with us.

What that 1 USDC turns into, at XLM ≈ $0.17:

| | USDC |
|---|---:|
| you send | 1.00 |
| bridge fee | −0.01 |
| **parked as a claimable balance** | **0.99** |
| claim fee (2 XLM reserve deposit + $0.05, ceiled to the cent) | −0.40 |
| **lands in the brand-new wallet, which paid zero gas** | **0.59** |
| reserve rebate if you later close the account (95%, in USDC) | +0.16 |
| **total recovered** | **0.75** |

Send more and only the claim fee stays flat — it is a fixed reserve deposit,
not a percentage, so a $100 order keeps ~$99.59. And if the destination
already has a USDC trustline there is no claim fee at all.

```bash
git clone <this repo> && cd rozo-paysponsor-demo
npm install
cp .env.example .env      # then put your funded Base private key in
                          # DEPOSIT_EVM_PRIVATE_KEY — .env is gitignored
```

The four scripts map one-to-one onto the steps below:

| Script | Step |
|---|---|
| `create-wallet.mjs stellar` | makes the fresh recipient wallet (§2) |
| `deposit-intents.mjs --amount 1` | quotes, then bridges (§1, §2) |
| `claim-intents.mjs` | the recipient's zero-gas claim (§4) |
| `close-intents.mjs --destination G…` | close + payout (§5) |

Each run spends real money — a $1 order costs $1 plus a fraction of a cent of
Base gas. Keys are read from `.env` or the gitignored `wallets/` directory and
are never passed on the command line.

---

## 1. Quote (dry run — creates nothing, spends nothing)

`POST /payments?dryrun=true` with the same body as a real create returns the
frozen fee math before any money moves. With `intent: "stellarsponsor"` the
response carries the sponsorship quote (current whole-cent fee rule):

```
$ node scripts/deposit-intents.mjs --amount 1
── dryrun quote ──────────────────────────────────────
mode                    sponsored        (destination has no trustline)
xlmUsdPrice             $0.175
sponsorFee              $0.40            (2 XLM × 0.175 + 0.05 = 0.40 → ceil to cent)
claimableBalanceAmount  0.99 USDC        (1.00 − $0.01 bridge spread)
netAmount               0.59 USDC        (0.99 − 0.40)
──────────────────────────────────────────────────────
The quote is printed automatically before every deposit — the script prices the
order first and only then creates it, so you always see the fee before any
money moves.
```

`mode: "direct"` would mean the destination already has the USDC trustline —
no sponsorship needed, no sponsor fee.

## 2. Bridge — $1 USDC in on Base

The real create returns a dedicated deposit address; one plain ERC-20
transfer funds the intent. No approvals, no contract calls from the payer.

```
$ node scripts/deposit-intents.mjs --amount 1
intent created  intent: stellarsponsor  destination: GCWV4GAB…YPKF2L6N
deposit address (Base): 0xa443f34ef6cb4aef4107ebc11ca214238f8FE60a
sending 1.000000 USDC from 0xee0C2094…BF8987A5e3 …
✔ Base tx confirmed: 0x60ec5709f3709ad7f80e07ff97564d3a2958a19378dae378c8634ab30cc2589b
```

![Base deposit transaction](docs/img/02-deposit-base.png)

Explorer: [Basescan](https://basescan.org/tx/0x60ec5709f3709ad7f80e07ff97564d3a2958a19378dae378c8634ab30cc2589b) ·
[Blockscout](https://base.blockscout.com/tx/0x60ec5709f3709ad7f80e07ff97564d3a2958a19378dae378c8634ab30cc2589b)

## 3. Park — claimable balance on Stellar

Within ~2 minutes the custody account parks the full bridged amount (0.99
USDC) as a **claimable balance**. Note the two claimants: the recipient (any
time before the 30-day TTL) and custody (reclaim after expiry). The recipient
account still does not exist on-chain at this point.

```
$ curl -s $API/payments/$ID/claim | jq '{status, amount, claimableBalanceId}'
{
  "status": "claim_ready",
  "amount": "0.99",
  "claimableBalanceId": "00000000acb139f478147838a81e63ef518e82ddf28a590bbeec5963949b4bd8b492680d"
}
```

![Park transaction — claimable balance created](docs/img/03-park-tx.png)

Explorer: [stellar.expert — park tx `67831ee9…`](https://stellar.expert/explorer/public/tx/67831ee9160a8fbe06be7f163dbf610e77c77c365bc57e20faccb506bb685c6d)

## 4. Claim — one signature, zero gas

The recipient asks the API to build a sponsored transaction, signs it
**locally** with their own key, and submits the XDR back. In one atomic
transaction Rozo's signer sponsors the reserves, **creates the account with a
starting balance of 0 XLM**, establishes the USDC trustline, and the
recipient claims the balance. Fee payer: Rozo. XLM held by the recipient at
any point: **zero**.

```
$ node scripts/claim-intents.mjs
building sponsored claim for GCWV4GAB…YPKF2L6N …
✔ signable XDR received (824 bytes), signing locally
✔ submit accepted
✔ tx on Horizon: 287c03ceab932849d8556fd94e8748de30f84dfa58d05879e24c0c0956c33654
delivered: 0.6009920 USDC   (0.99 − 0.3890080 sponsor fee, old 7dp rate)
recipient XLM balance: 0 (all reserves sponsored)
```

![Claim transaction — sponsored account creation + trustline + claim](docs/img/04-claim-tx.png)

Explorer: [stellar.expert — claim tx `287c03ce…`](https://stellar.expert/explorer/public/tx/287c03ceab932849d8556fd94e8748de30f84dfa58d05879e24c0c0956c33654)

## 5. Close — sweep and merge, still zero gas

Account close is two sponsored legs, both fee-paid by Rozo:

**Leg 1 — transfer:** the remaining 0.6009920 USDC is sent to the
destination the user chose (`GD5R…BB4U`).

```
✔ leg 1 transfer: 1b0ea7f7a593649163d85ecd3da68b00299aef86e4accba6d94f5d315b07ed47
  0.6009920 USDC → GD5R4HTO…HUMI2BB4U
```

![Close leg 1 — USDC swept to destination](docs/img/05-close-transfer-tx.png)

**Leg 2 — merge:** the trustline is removed and the account is merged away.
The recipient account no longer exists on the ledger.

```
✔ leg 2 merge: 22b01834b81afd02389c14060496c061e64ed1ad0d81dd14817820e32e0ef2e4
  trustline removed, GCWV4GAB…YPKF2L6N merged into GD5R4HTO…HUMI2BB4U
account gone. awaiting reserve rebate…
```

![Close leg 2 — trustline removed, account merged](docs/img/05-close-merge-tx.png)

Explorer: [transfer `1b0ea7f7…`](https://stellar.expert/explorer/public/tx/1b0ea7f7a593649163d85ecd3da68b00299aef86e4accba6d94f5d315b07ed47) ·
[merge `22b01834…`](https://stellar.expert/explorer/public/tx/22b01834b81afd02389c14060496c061e64ed1ad0d81dd14817820e32e0ef2e4)

## 6. Rebate — sponsored reserves come back in USDC

Closing unlocks the sponsored XLM reserves. Rozo automatically rebates **95%
of the unlocked XLM, converted to USDC at execution-time price**, to the same
destination — the user ends the lifecycle holding only USDC, having never
owned XLM.

```
rebate detected on GD5R4HTO…HUMI2BB4U:
  +0.1635710 USDC  from custody GBLTI2TT…ADWMXUAE  (95% × 1 XLM × spot)
lifecycle complete: deposit → park → claim → close → rebate, user gas paid: $0
```

The destination account history shows all three arrivals — the swept
balance, the merge, and the rebate payment from custody:

![Destination account history — sweep, merge, rebate](docs/img/06-rebate-destination.png)

Explorer: [stellar.expert — destination account `GD5R…BB4U`](https://stellar.expert/explorer/public/account/GD5R4HTO5Y22ZNBD2ZZDJHFYN5JDYHDHG3VINLPM2ZU7HCIHUMI2BB4U)

---

## Timeline recap

| UTC (2026) | Event | Tx |
|---|---|---|
| 07-31 ~13:11 | $1 USDC deposit on Base | `0x60ec5709…30cc2589b` |
| 07-31 13:13:12 | Park: 0.99 USDC claimable balance created | `67831ee9…bb685c6d` |
| 07-31 15:45:25 | Claim: sponsored create + trustline + claim, 0 gas | `287c03ce…56c33654` |
| 07-31 16:42:21 | Close leg 1: 0.6009920 USDC swept to destination | `1b0ea7f7…15b07ed47` |
| 07-31 16:42:38 | Close leg 2: trustline removed, account merged | `22b01834…2e0ef2e4` |
| 08-01 00:10:45 | Rebate: +0.1635710 USDC from custody to destination | (payment on destination account) |
