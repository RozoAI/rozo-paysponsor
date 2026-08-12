# Maintainers

This project follows a two-maintainer minimum: no single person should be the
only one able to review, release, or respond to a security report here.

| Maintainer | GitHub | Area |
|---|---|---|
| Shawn Muggle | [@shawnmuggle](https://github.com/shawnmuggle) | Scripts, API surface, signing guard |
| _(second maintainer — see below)_ | _TBD_ | Docs, walkthrough, examples |

## Current status

We are actively onboarding a second maintainer. Until that seat is filled, this
project has a **pony factor of 1**, and we state that plainly rather than hide
it: if you are depending on this code, know that today it rests on one person.

## Becoming a maintainer

There is no application form. The path is the usual one for small open-source
projects:

1. Land a few meaningful contributions — documentation, a reproduction of the
   walkthrough on your own wallet, a fix, or a test.
2. Review someone else's pull request.
3. Ask. We will add you to this table and grant write access.

We are especially interested in co-maintainers from the Stellar ecosystem who
have hit the new-account onboarding cliff themselves.

## What a maintainer is expected to do

- Respond to issues within roughly a week, even if only to say "not yet".
- Review pull requests, and never self-merge a change to the signing guard
  (`scripts/xdr-guard.mjs`) without a second pair of eyes.
- Re-run the walkthrough against production before tagging a release, so the
  documented numbers stay true.

## If this project receives ecosystem funding

This project is a candidate for the Stellar Community Fund's Public Goods
Award. Nothing has been applied for or awarded yet — this is intent, not a
contract.

If an award does arrive, direct project costs come out first, and what remains
is shared with the people who did the work that quarter, weighted by
contribution visible in this repository: merged pull requests, documentation,
reviews. That includes outside contributors, not only the maintainers above.

We are not publishing a percentage today, because a number invented now would
be a worse promise than an honest principle. The first split will be proposed
publicly in an issue before it is paid.

## Security reports

Do not open a public issue for a vulnerability in the signing guard or in the
sponsored-claim flow. Email **security@rozo.ai** instead. Never include a secret
key, seed phrase, or API key in a report — a transaction hash and a description
are enough.
