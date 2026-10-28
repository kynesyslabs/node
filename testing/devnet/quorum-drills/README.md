# Quorum failure drills

Runs the quorum scenarios of the launch plan on a local devnet with N
validators, one command per scenario, and decides pass/fail by itself. It
follows the conventions of `../consensus-race/` (prebuilt image, optional
`src/` overlay, tmpfs state, per-run dir, auto-teardown); the compose file
is generated per run because N changes between scenarios.

```
testing/devnet/quorum-drills/run.sh [--image IMAGE] [--src TREE] [--binding on|off] <scenario> [label]
```

- `--image` (or `IMAGE`): a prebuilt node image. Default
  `demos-node:candidate-5979a716`. The harness never builds images.
- `--src` (or `SRC_TREE`): a source tree whose `src/` and `bunfig.toml` are
  bind-mounted read-only over the image's, to test code without a rebuild.
  The tree must match the image's dependencies.
- `--binding` (or `BINDING`): `on` (default) activates `committeeBinding`
  at block 0; `off` keeps it dormant to reproduce the pre-fork behaviour on
  the same code. `quorumParity` is active from block 0 in both.

Exit code 0 means pass, 1 fail, 2 the run could not be carried out
(preflight, boot, timing). Each run appends a row to `runs/results.tsv`.

## Scenarios

`q = floor(2 * shardSize / 3) + 1`. With N <= shardSize the bound committee
is every validator, so the chain forges exactly when at least q of them are
live.

| Scenario | N | shardSize | q | What it does | Pass when |
|---|---|---|---|---|---|
| `floor` | 4 | 10 | 7 | Boots 4 validators on the stock devnet shardSize | No block past 0 after 8 rounds, and the nodes log `below the quorum of 7` (or `below the floor of 7`) |
| `drop-n7s7` | 7 | 7 | 5 | Stops validators 7, 6, 5 in turn, each mid-round, then restarts them | Progress at 6 and 5 live, stall at 4 live, progress after the restart |
| `drop-n7s10` | 7 | 10 | 7 | Stops validator 7 mid-round, then restarts it | Stall at 6 live, progress after the restart |
| `drop-n10s10` | 10 | 10 | 7 | Stops validators 10, 9, 8, 7 in turn, then restarts them | Progress at 9, 8, 7 live (round times recorded), stall at 6, progress after the restart |
| `listed-stall` | 10 staked, 7 running | 10 | 7 | Stops a listed validator, starts the 3 staked ones that never ran, then brings the listed one back | Stall after the stop, still stalled with the 3 extras up (the listed pool holds q, so the staked-set fallback does not apply), progress once the listed one is back |
| `fallback` | 10 | 10 | 7 | Stops every node on one head, rewrites that block's committed peerlist in every database to 6 validators (below q), restarts all 10 | `--binding on`: progress, with the `drawing the committee from all 10 staked validators` log line. `--binding off`: stall (the pre-fork pool is the 6 listed) |
| `partition` | 6 | 4 | 3 | Splits the network into {1,2,3} and {4,5,6} for `PARTITION_TIME`, then heals it | `--binding on`: at most one side forges, no height carries two hashes, one chain after the heal. `--binding off`: both sides forge, two hashes at one height (the pre-fork finding) |

`fallback` injects its state through the database because an honest run
does not produce it: a block is committed by q live members, who also end up
in its peerlist. The edit keeps the stored block hash and key order, and it
is the same on every node.

A 14-validator split (two groups of 7 at shardSize 10) does not fit a shared
host; `partition` shows the same property at shardSize 4 (pool 6 = 2q), and
the real-ed25519 suite in
`src/libs/blockchain/validation/verifyBlock.crypto.test.ts` covers the pool
of 14.

## Runs and logs

Everything goes to `runs/<UTC time>-<scenario>-<binding>-<label>/`
(gitignored, mode 700): `inputs/` (identities, genesis, peerlist, compose
file: devnet keys, never commit them), `logs/01-preflight.log` ..
`05-verdict.log` per step, `events.log` with a timestamped line per stop,
start and partition change, `node-N.log` (full container logs, collected at
teardown), `phases.tsv` (per phase: validators down and live, height range,
blocks, mean and longest gap between block timestamps, outcome),
`verdict.json` and `run.log` with the whole run.

## Isolation on a shared host

- Preflight aborts when free disk is under 10 GB, available RAM is under
  `START * NODE_EST_MB + 256 + HEADROOM_MB` (1100 MB per node, 3 GB
  headroom), the 1-minute load is above the core count, the host is
  swapping, an image is missing, or another `crace-`/`qdrill-` stack is
  running.
- A unique compose project per run (`qdrill-<run id>`), no container names,
  no published ports (the harness uses `docker exec`), postgres and node
  state on tmpfs, no named volumes. Memory caps: `NODE_MEM` (1800m) per
  node, 1 GB postgres, 64 MB per partition sidecar.
- A trap collects the logs, removes the sidecars and runs
  `docker compose down -v --remove-orphans` on any exit, including Ctrl-C.

## Tuning

`CONSENSUS_TIME` (10), `GENESIS_DELAY` (60 + 25 s per node),
`LOCKSTEP_TIMEOUT` (420), `PROGRESS_BLOCKS` (3), `PROGRESS_TIMEOUT` (180),
`STALL_WINDOW` (120), `PARTITION_TIME` (120), `SETTLE_TIMEOUT` (300),
`NETSHOOT_IMAGE`, `RUNS_DIR`.

## Notes

- Gossip is off by default, as in the race harness; `GOSSIP_ENABLED=true`
  turns it on. With gossip off, a node learns that a peer is ahead only
  from that peer's block push: a sync claim above our own height is
  discarded until it can be checked.
- Validators are stopped with `docker compose stop -t 0` right after a
  round start is logged, so the restart policy leaves them down.
- Round times come from block timestamps, so they show the chain's own
  pace, including retries at a height.
