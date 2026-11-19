# Requester fixtures for node #1059 and #1060

Testnet fixtures and negative cases from PATH-OS (cX3po), attached to:

- https://github.com/kynesyslabs/node/issues/1059#issuecomment-6202239144
- https://github.com/kynesyslabs/node/issues/1060#issuecomment-6202241690

Source: gist https://gist.github.com/cX3po/34c49f2360e8ea88ca882f88377da41a
(prepared 2026-10-15). The gist flattens `fixtures/` and `negative/` into
`fixtures__*` and `negative__*`; they are restored here under their original
paths, so `MANIFEST.json` applies unchanged. The JSON files are byte-for-byte
the published ones; `requesterFixtures.test.ts` checks them against the
manifest. The package's own README, requirement map and sanitize report are
not copied (the manifest still lists them).

The package holds observations and client-side results only: no node proof
object, no private key or mnemonic. Nothing in it is executed; the tests read
it as data.

Tests that use it:

- `src/libs/blockchain/finality/requesterFixtures.test.ts`: the offline
  verifier, storage records and capacity rules against each fixture.
- `src/libs/network/routines/nodecalls/requesterFixtures.status.test.ts`: the
  status call against F02, F04, N01 and N07.
- `src/libs/network/routines/nodecalls/requesterFixtures.head.test.ts`: the
  finalized head against F01, N01 and N04.
