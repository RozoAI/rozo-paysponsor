# Contributing

Thanks for looking. This repository is small on purpose: a set of scripts that
prove out sponsored onboarding for brand-new Stellar wallets, plus a signing
guard that refuses to hand your key to a transaction you did not ask for.

## Ground rules

**Never commit a secret.** `.env`, `wallets/` and every `.env.*` file (except
`.env.example`) are gitignored. Scripts read keys from the environment or from
local `0600` files — never from command-line arguments, never hard-coded. If you
add a script, keep that property.

**Never paste a secret into an issue or pull request.** A transaction hash, an
address, and an error message are enough to debug anything here.

**The signing guard is the safety-critical file.** Changes to
`scripts/xdr-guard.mjs` require review by a maintainer who did not write them.
If your change loosens a check, say so explicitly in the pull request and
explain what still prevents a malicious server from collecting a signature it
should not get.

## Running it

Every run spends real money on production — roughly $1 USDC plus a fraction of a
cent of Base gas, of which about $0.75 comes back if you close the account
afterwards. There is no testnet path today. See the README for setup and the
[walkthrough](WALKTHROUGH.md) for a recorded run.

Use a **dedicated key** that signs for nothing else. `create-wallet.mjs`
generates one for you; the guard's threat model assumes it.

## Pull requests

- Keep changes focused; one concern per pull request.
- If you change a documented number (a fee, a limit, a net amount), re-run the
  affected leg and update the README, the walkthrough, and `.env.example`
  together — the three are meant to agree.
- Documentation, corrections and reproductions are genuinely welcome
  contributions, not lesser ones. If you ran the walkthrough and something did
  not match, that is worth an issue.

## Reporting a vulnerability

Email **security@rozo.ai** rather than opening a public issue. See
[MAINTAINERS.md](MAINTAINERS.md).
