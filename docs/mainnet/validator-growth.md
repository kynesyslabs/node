# Validator set growth after launch

Decided 2026-11-27 (mainnet-launch#11).

## How the set grows

The set is not fixed at genesis. `tokenStaking` and `nftValidatorGating` are
active from block 0 (`docs/mainnet/genesis.md`), so from block 1 anyone who
holds an allowlisted Demos Node NFT can take a seat with one `validatorStake`
and a Solana proof that the NFT's wallet backs the validator
(`docs/runbooks/validator-staking.md`). No DEM is bonded and seat
transactions pay no gas.

- **Upper bound.** One seat per allowlisted NFT: 460 mints in
  `src/features/staking/nft-allowlist.json` today, about 500 after the last
  genesis mints. The list is pinned by sha256 and checked at apply, so every
  validator holds the same list.
- **No per-owner limit.** Anyone runs as many validators as they hold NFTs
  for; go/no-go reports concentration as an advisory note
  (`docs/mainnet/launch-validators.md`, rule 6).
- **Committee.** `shardSize` is 10 from block 0 and a block needs 7
  signatures. A larger set does not make a block need more signatures; it
  spreads committee seats across more operators.
- **Floor.** No unstake and no challenge takes the active set below 7.

## Targets

| When | Active validators | Why |
|---|---|---|
| Genesis | at least 7, aim for 10 | 7 is the go/no-go minimum; 10 fills the committee, so 3 can fail |
| Launch + 30 days | 15 | committee seats rotate across more operators than one committee |
| Launch + 90 days | 25 | no single provider or region near a third of the set |

These are what the launch coordinator tracks, not protocol limits. The
coordinator reviews them at each date and posts to the team the count of
active seats from `getValidators` and the provider and region split from the
operator inventory (the RPC carries neither: each operator gives its provider
and region when it is listed, item 4 below).

## Approval

The protocol admits a seat: an allowlisted mint, a valid Solana proof from
the wallet that holds it, and a mint that backs no other seat. Nobody signs
off a seat by hand, so there is no off-chain allowlist that grants signing
power.

Before the coordinator lists a new validator as an operator (status page,
monitoring, war-room channel), the operator posts:

1. `./scripts/node-doctor --production` PASS against `docs/mainnet/parameters.env`,
   with the image digest of the signed release it runs.
2. `getValidatorInfo` for its address with `status` `"2"` (active) and its
   `nftMint`.
3. A signed block from its production host, read from the chain.
4. Its hosting provider and region, for the operator inventory.

## Revoke at every change

When a validator exits, is challenged out, or changes operator:

- Remove its scrape target and its `basic_auth` entry from monitoring
  (`docs/runbooks/mainnet-monitoring.md`).
- Remove the operator from the war-room and status channels if it holds no
  other seat.
- Challenge the seat (`bun run validator:challenge`) if its NFT left the
  proving wallet and the seat is still active.
- If the operator held a release-signing key, remove it from
  `.github/allowed_signers` in the next release.
- Never edit the allowlist JSON on a running network. Adding or removing a
  mint is a consensus change: a height-scoped rule in a signed release.

Once a month the coordinator compares the monitoring targets, the channel
members and `getValidators`, and removes anything that no longer matches an
active seat.
