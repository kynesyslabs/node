# Upgradable Network — Testing Guide

How to verify the `upgradable_network` branch (Phase 0 staking + Phase 1
governance / Stackable Genesis) at every level: unit, SDK contract, full
end-to-end on a 4-node Docker devnet.

## TL;DR

```bash
# Unit + integration (~1 sec, 134 tests across 15 suites)
bun run test:upgradable

# SDK shape contract — no node required
bun run test:upgradable:sdk

# Full E2E on 4-node Docker devnet, FAST mode (~5 min)
bun run test:upgradable:e2e:fast

# Same E2E with production constants (~25 min, voting window = 100 blocks)
bun run test:upgradable:e2e
```

Run `bun run test:upgradable` before every commit. Run `e2e:fast` before
every push.

## Test layers

### 1. Unit + integration — `bun run test:upgradable`

15 Jest suites, 134 tests, ~1 sec wall-clock.

| Suite | What it covers |
|------|---------------|
| `tests/staking/handleStakingTx.test.ts` | dispatcher path for `validatorStake`/`Unstake`/`Exit` validation |
| `tests/staking/validatorsManagement.test.ts` | edit-builder + validation entry points |
| `tests/staking/validatorHandlers.test.ts` | RPC `getValidatorInfo`/`getValidators`/`getStakedAmount` |
| `tests/staking/gcrValidatorStakeRoutines.test.ts` | apply-stake/unstake/exit edits against the Validators table |
| `tests/staking/integration.test.ts` | end-to-end staking lifecycle through mocks |
| `tests/governance/handleGovernanceTx.test.ts` | proposal + vote validation |
| `tests/governance/governanceHandlers.test.ts` | RPC handlers for proposals / votes |
| `tests/governance/safetyBounds.test.ts` | 50% per-proposal cap + absolute floors/ceilings |
| `tests/governance/loadNetworkParameters.test.ts` | folding active upgrades onto genesis defaults |
| `tests/governance/applyNetworkUpgrade.test.ts` | post-block activation hook |
| `tests/governance/tallyUpgradeVotes.test.ts` | 2/3 supermajority by stake-weighted vote |
| `tests/governance/snapshotWeightIntegrity.test.ts` | vote weight frozen at snapshot block |
| `tests/governance/concurrentProposals.test.ts` | key-conflict / one-proposer-at-a-time |
| `tests/governance/deriveFeesFromParameters.test.ts` | `resolveDynamicFees()` reads from `sharedState.networkParameters` |
| `tests/governance/e2e.test.ts` | full happy path + failed-proposal path through mocks |

These suites mock the datasource and RPC. They catch logic regressions
in seconds. Always green before committing.

### 2. SDK shape contract — `bun run test:upgradable:sdk`

`scripts/upgradable-network/sdk-builders.test.ts` exercises every SDK
builder (`stake`, `unstake`, `validatorExit`, `proposeNetworkUpgrade`,
`voteOnUpgrade`) through the real `@kynesyslabs/demosdk` linked locally
via `sdks_ref/`. No node / RPC required — `getAddressNonce` is stubbed.

This catches the class of bug where a Jest unit test hand-crafts a tx
object and never calls the real builder, so a missing field in the
builder output (e.g. `tx.content.to`) sneaks past a green suite.

### 3. Full E2E — `bun run test:upgradable:e2e[:fast]`

Driver: `scripts/upgradable-network/e2e.sh`.

What it does, in order:

1. `docker compose -f testing/devnet/docker-compose.yml down -v` —
   wipes any previous state.
2. Builds the devnet image. In FAST mode, first patches
   `VOTING_WINDOW_BLOCKS=10` / `GRACE_PERIOD_BLOCKS=5` in
   `src/features/networkUpgrade/constants.ts` for the test (restored
   on exit via `trap`).
3. Brings up 4 Dockerised nodes, waits for block production.
4. Stakes 4 validators in parallel via 4 different RPCs. Asserts the
   `validators` row count == 4 on all 4 node DBs.
5. Submits a `networkFee 10 → ${PROPOSED_FEE}` proposal. Asserts the
   row replicates to all 4 node DBs.
6. Submits 4 yes-votes from the 4 validators. Asserts each
   confirmation block is recorded.
7. Waits for `tally_block`, asserts `status=activating` on every node.
8. Waits for `effective_at_block`, asserts `status=active` on every node.
9. Calls `getNetworkParameters()` on every node, asserts the new
   `networkFee` is reflected.
10. Submits a fresh native `pay` tx, asserts the **SDK signed it with
    `network_fee=${PROPOSED_FEE}`** (this is the SDK fee-fix
    smoke-gun).
11. Optionally asserts the persisted `transactions.networkFee` column
    matches on all 4 nodes (skipped with a WARN if peer-mesh churn
    delays propagation past the 90s window).
12. `docker compose down -v` (unless `KEEP_DEVNET=1`).

#### Output

Every step writes to `e2e-runs/<UTC-timestamp>/`:

- `SUMMARY.txt` — chronological log with `PASS:` / `FAIL:` / `WARN:` per
  assertion, plus the final banner.
- `build.log`, `up.log`, `down.log`, `teardown.log` — Docker steps.
- `stake-{1..4}.log`, `vote-{1..4}.log` — per-validator submission output.
- `propose.log`, `proposal-replicated.log`, `proposal-meta.log`.
- `tally-status.log`, `activation-status.log`, `live-params.log`.
- `pay.log`, `persisted-fee.log`.

#### Exit codes

| Code | Failure step |
|------|-------------|
| 0 | All assertions passed |
| 1 | Setup / Docker build / preflight |
| 2 | Staking phase |
| 3 | Proposal phase |
| 4 | Voting phase |
| 5 | Tally / activation phase |
| 6 | Tx fee verification phase |

Useful in CI: `bun run test:upgradable:e2e:fast || exit $?`.

#### Environment knobs

| Variable | Default | Effect |
|---------|---------|--------|
| `FAST` | `0` | If `1`, patches voting window to 10 / grace to 5; restores via trap. |
| `CONSENSUS_TIME` | `10` | Seconds per block (plumbed into docker-compose). Use `2` for fast runs. |
| `PROPOSED_FEE` | `12` | The new `networkFee` value the proposal targets. |
| `RECIPIENT` | `0x10bf4d…2420c` | Genesis-funded recipient for the verification tx. |
| `KEEP_DEVNET` | `0` | If `1`, leaves containers running on exit (debugging). |

## Test directory layout

```
tests/
├── governance/                                    # Phase 1 unit suites (10 files)
└── staking/                                       # Phase 0 unit suites (5 files)

scripts/upgradable-network/
├── README.md                                      # quick reference for these helpers
├── e2e.sh                                         # end-to-end harness
├── cli.ts                                         # SDK CLI for live debugging
├── gen-identity.ts                                # devnet identity generator
└── sdk-builders.test.ts                           # SDK shape contract test

testing/devnet/
├── docker-compose.yml                             # 4-node + Postgres + tlsnotary
├── Dockerfile                                     # node image (links sdks_ref/)
└── identities/                                    # canonical pre-generated identities

e2e-runs/                                          # gitignored, one dir per run
└── <UTC-timestamp>/
    ├── SUMMARY.txt
    └── *.log
```

## Pre-flight checklist for new contributors

1. Clone `@kynesyslabs/demosdk` into `./sdks_ref` (gitignored, see
   project root README §0).
2. `cd sdks_ref && bun install && bun run build && cd ..`.
3. `bun install` at repo root.
4. `bun run test:upgradable` — should print `134 passed`.
5. `bun run upgradable:gen-identity` — generates `.devnet/canon_id{1,2,3,4}`.
6. `bun run test:upgradable:e2e:fast` — should pass within ~5 min.

If any step fails, fix it before opening a PR — none of these are
flaky in a clean environment.

## Continuous integration

`bun run test:upgradable` and `bun run test:upgradable:sdk` are fast
enough to run on every PR. The full E2E (`test:upgradable:e2e:fast`)
should run at least nightly or on merges to `testnet`/`main`. The CI
runner needs Docker + ~3 GB free disk for the devnet image.

## Known limitations / things to watch

- Native `pay` tx propagation across the 4-node mesh is occasionally
  flaky during E2E (`no_cert` TLS rejections in DTR relay). Doesn't
  affect staking/governance flows because they go through the
  relay-and-sign path that survives this churn. The SDK pre-sign
  assertion always passes; the persisted-fee assertion skips with a
  WARN if propagation lags past 90 s. Tracked separately from the
  upgradable-network branch.
- `sdks_ref/src/websdk/demosclass.ts` carries the SDK fee-fix as
  uncommitted work in that separate repo. The SDK has to land + ship
  a published version before this branch can drop the `file:./sdks_ref`
  link.
- Pre-existing TypeScript errors (~10) in unrelated areas (Bun v1.3
  generic constraints on IMP, l2ps-messaging, MCP, metrics, bunServer,
  rateLimiter) — `tsc --noEmit` is **not** clean repo-wide; only the
  upgradable-network code is. Filter with `grep -v node_modules` and
  ignore those file paths when reading typecheck output.
