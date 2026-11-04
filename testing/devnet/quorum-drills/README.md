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

### How a node starts

`run.sh` looks in the image for `./testing/devnet/run-devnet` and picks the
start path from the result (`start=` in the preflight line of `run.sh`'s log):

- **Image has `run-devnet`** (a devnet-style image, `testing/devnet/Dockerfile`):
  `bash -lc 'cp the identity into /app/state && exec ./testing/devnet/run-devnet'`,
  as in every earlier round. The generated compose of the seven older
  scenarios is byte-identical to before on this path.
- **Image has none** (a release image, root `Dockerfile`, which copies only
  `src/ scripts/ data/ sdk/ libs/ sidecar/` and never `testing/`): the image's
  own `ENTRYPOINT` (`scripts/docker-entrypoint.sh`) and `CMD`
  (`bun -r tsconfig-paths/register src/index.ts -- --no-tui`), read from the
  image with `docker image inspect` and written into the compose file. The only
  addition is a `/bin/sh -c` step before them that copies the mounted identity
  and peerlist into the uid-owned `/app/state` tmpfs (the node keeps its
  identity lock and signing record next to the identity file, and `/app/keys`
  is read-only), then `exec`s the image's entrypoint with its CMD. The drill
  sets `RPC_PORT` (run-devnet turns its `PORT` into it), `IDENTITY_FILE`,
  `EXPOSED_URL`, `PG_*`, `CONSENSUS_TIME`, `OMNI_*`, `GOSSIP_ENABLED` and the
  mounts; the peerlist is mounted at `/app/keys/demos_peerlist.json`, not at
  `/app/demos_peerlist.json`, because the entrypoint `mv`s a real file it finds
  there into `/app/state` and a bind mount cannot be moved.

What still differs from mainnet on the image path: `NODE_ENV=development` (a
production node needs `EXPECTED_GENESIS_HASH` for a genesis that is new each
run, `genesisPin.ts:56-67`), postgres and `/app/state` on tmpfs, the generated
genesis and the empty snapshot, `OMNI_MODE=HTTP_ONLY`, TLSNotary off, and no
published ports.

The preflight checks that everything the node service execs exists and is
executable for the image's user (`docker run` as its default user): `sh cp`, the
image's entrypoint and the first word of its CMD on the image path; `bash cp
./testing/devnet/run-devnet bun` on the other. On the image path it also runs
node-1's generated entrypoint once, with its mounts and tmpfs and a check in
place of the CMD, so an entrypoint that would abort before the node starts, or
a missing identity or peerlist, ends the run as `ABORT` (exit 2) before any
node is started.

`demos-node:candidate-5979a716` is not described anywhere in the repo: only
`run.sh` and the two READMEs name it, and the harness never builds images, so
how it was built is not recorded here. The consensus-race harness execs
`run-devnet` in it, so it probably has the file; the check above decides, not
that guess.

Exit code 0 means pass, 1 fail, 2 the run could not be carried out
(preflight, boot, timing). A running node whose head cannot be read during
an observation window (three tries) ends the run as `ERROR`, exit 2: a
crashed node must not pass for a stalled one. Each run with a verdict
appends a row to `runs/results.tsv`. Log-line counts (floor refusals,
fallback lines) only take lines logged in the window being judged.

## Scenarios

`q = floor(2 * shardSize / 3) + 1`. With N <= shardSize the bound committee
is every validator, so the chain forges exactly when at least q of them are
live. With N > shardSize (`halt-n13s10`, `ride-n13s10`) it does not: see
[Mainnet-shape halt and ride drills](#mainnet-shape-halt-and-ride-drills).

| Scenario | N | shardSize | q | What it does | Pass when |
|---|---|---|---|---|---|
| `floor` | 4 | 10 | 7 | Boots 4 validators on the stock devnet shardSize | No block past 0 after 8 rounds, and the nodes log `below the quorum of 7` (or `below the floor of 7`) |
| `drop-n7s7` | 7 | 7 | 5 | Stops validators 7, 6, 5 in turn, each mid-round, then restarts them | Progress at 6 and 5 live, stall at 4 live, progress after the restart |
| `drop-n7s10` | 7 | 10 | 7 | Stops validator 7 mid-round, then restarts it | Stall at 6 live, progress after the restart |
| `drop-n10s10` | 10 | 10 | 7 | Stops validators 10, 9, 8, 7 in turn, then restarts them | Progress at 9, 8, 7 live (round times recorded), stall at 6, progress after the restart |
| `halt-n10s10` | 10 | 10 | 7 | Stops validators 7-10 at once (6 live < q), holds for `HALT_ROUNDS` rounds, restarts them | Scenario 12's P1-P6, judged by `judgeHaltDrill.ts` (below) |
| `halt-n13s10` | 13 | 10 | 7 | Stops validators 7-13 at once (6 live < q, a pool larger than the committee), holds, restarts them | Same P1-P6 |
| `ride-n13s10` | 13 | 10 | 7 | Stops validators 11-13 at once (3, the most the committee code guarantees), waits for `RIDE_BLOCKS` blocks | P1 baseline, R2 ride (every survivor reaches pre-stop + `RIDE_BLOCKS`, one hash per height, every block >= 7 signatures), P6 no crash |
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

## Mainnet-shape halt and ride drills

`halt-n10s10`, `halt-n13s10` and `ride-n13s10` run the drill of rehearsal
scenario 12 (`../../forks/rehearsal/scenarios/12-quorum-loss-halt-recovery.ts`,
2 of 4 validators at shardSize 4) at mainnet's shardSize 10. The Docker runs
of these three cases have **not been run** yet. What was run offline: the unit
tests of the judge, and the bash glue against a mocked chain (no containers).

### Which validators are stopped

With `committeeBinding` active (block 0 here, `gen-inputs.py`; `--binding on`),
read from `src/libs/consensus/v2`:

- **Pool.** The committee for block B is drawn from the peerlist committed in
  block B-1, intersected with the staked set (`routines/getShard.ts:133-146`,
  `chainEligiblePool`). Only when that pool holds fewer than q = 7 identities
  does it become the whole staked set (`getShard.ts:244-267`, `getBoundPool`);
  at a block without a peerlist (block 0) it is the staked set
  (`getShard.ts:156-160`). It is not all staked validators in the normal case.
- **Draw.** The pool is ranked with `Alea(seed)` and the first `shardSize`
  identities are the committee (`getShard.ts:223-233`, `287-293`). The seed
  is the common validator seed of the parent block (`getShard.ts:304-317`), so
  which validators are drawn is not known before that block exists.
- **Offline members are not filtered out.** They stay in the committee and
  count as missing votes (`getShard.ts:295-303`, `420-445`). Only the
  pre-fork path drops them and takes the next live identity
  (`getShard.ts:389-392`; run with `--binding off` to see it).
- **What a block needs.** 2/3 + 1 of shardSize = 7 signatures
  (`quorum.ts:10`, `19-27`), counted only from committee members
  (`src/libs/blockchain/validation/verifyBlock.ts:138-143`, `158-195`). A
  producer commits on the same bar (`PoRBFT.ts:1415-1422`).
- **What the next pool is.** The committed peerlist lists the identities that
  at least 7 committee voters saw at the parent block
  (`routines/peerlistMerge.ts:205-253`, `267-314`; the bar is `quorumThreshold(shardSize)`
  at `:281-283`). A voter counts a peer only if its last known sync state is
  exactly the parent block (`peerlistMerge.ts:92-105`), so a stopped
  validator drops out of the pool once the chain has moved past the height it
  stopped at; the block right after the stop can still list it.
- **Secretary and floor.** Only live committee members form the shard; fewer
  than q refuse to forge, and the secretary is the first live member that
  holds our tip, replaced when it goes offline
  (`types/secretaryManager.ts:255-270`, `299-306`, `548-592`).

What follows for 13 validators and a committee of 10:

| Validators down | Outcome | Why |
|---|---|---|
| 7 or more (6 or fewer live) | **Always halts.** | A block needs 7 signatures from live committee members, and 6 validators cannot give them, whatever the draw. `halt-n13s10` stops 7. |
| 4 to 6 | **Depends on the draw**, no pass criterion. | At the first block after an at-once stop the pool is the pre-stop peerlist (13); if 4 or more of the 10 drawn are down the block cannot reach 7, and every retry at that height draws the same committee. If 3 or fewer are, the block lands, the down validators leave the next pool, and the chain can go on down to 7 live. |
| 3 or fewer | **Keeps forging**, provided the pool the committee is drawn from holds at least 10 identities. | The committee has 10 members and at most 3 of them are down, so at least 7 are live. `ride-n13s10` stops 3. |

At best the chain stalls from 7 down, at worst from 4 (when the draw puts 4
of them in the committee). 4 to 6 down is deliberately not a case: its
expected result would be a guess. The 3 is `guaranteedTolerance(shardSize,
pool)` = `min(shardSize, pool) - q` in `judgeHaltDrill.ts`, and the judge
refuses a ride drill with more stopped, or one whose pre-stop block lists
fewer validators than the committee (`run.sh` aborts with exit 2 before
stopping anything in that case). For `halt-n10s10` the committee is all 10,
so 4 stopped leave 6 < 7.

The victims are the highest-numbered nodes, so node-1, the only validator in
the seed peerlist, stays up.

### Pass criteria

Scenario 12's, judged by `testing/forks/rehearsal/lib/haltDrill.ts`:

- P1 baseline: all N nodes at a height >= `BASELINE_HEIGHT` (6), one hash.
- P2 settle: after `SETTLE_ROUNDS` rounds the survivors agree on a head (the
  halt height), and every block from pre-stop + 1 to it is stored by all
  survivors with one hash and >= q signatures (`evaluateSettle`).
- P3 halt: for `HALT_ROUNDS` rounds every survivor answers and stays at the
  halt height (`evaluateHalt`). An unanswered read is a P3 failure (exit 1),
  not the `ERROR` of the other scenarios: the criterion is that they answer.
- P4 halt agreement: survivors hold one hash at the halt height.
- P5 recovery: after the restart all N reach halt + `RECOVERY_BLOCKS` within
  `RECOVERY_TIMEOUT`, every height from pre-stop to the target has one hash
  on all nodes, every block above pre-stop has >= q signatures
  (`evaluateRecovery`). Running out of time is a failure, not `ERROR`.
- P6 no crash: survivors' Docker restart counts are unchanged.
- `ride-n13s10`: P1, R2 (the 10 survivors reach pre-stop + `RIDE_BLOCKS` in
  `RIDE_TIMEOUT`, one hash per height, every block >= q signatures) and P6.
  The stopped validators are not restarted.

### Where the verdict is computed

`run.sh` stops and starts the containers and writes what it saw (heads, block
rows with signature counts from `validation_data->'signatures'`, restart
counts, wall-clock marks) to `drill-input.json`. It then runs
`bun testing/forks/rehearsal/lib/judgeHaltDrill.ts drill-input.json --out drill-verdict.json`
and takes its exit code (0 pass, 1 fail, 2 malformed input, which `run.sh`
reports as `ERROR`). The judge imports `evaluateSettle`, `evaluateHalt`,
`evaluateRecovery`, `evaluateNoCrash`, `agreedHeight`, `signatureQuorum` and
`phaseDurations` from `haltDrill.ts`, so the criteria are scenario 12's and
nothing is re-implemented in bash.

The script is in `testing/forks/rehearsal/lib/`, next to `haltDrill.ts`: it
imports it by a relative path, and its unit tests (`judgeHaltDrill.test.ts`,
fixtures in `fixtures/halt-judge/`) run with the rest of the rehearsal suite,
`bun test testing/forks/rehearsal/`. Beside `run.sh` it would have sat outside
that suite and imported across trees. `bun` must be on the PATH, as it already
is for the identity generation.

The judge prints the same `DRILL_TIMINGS {json}` line as scenario 12 (cold
start to baseline, stop to halt confirmed, halt hold, restart to first new
block, restart to all converged, total), also in `run.log` and under `drill`
in `verdict.json`. `cold start` starts when all N validators serve, so it
includes the wait for the genesis time. `ride-n13s10` reports stop to first
new block and stop to target instead of the restart timings.

### Resources per case

From the preflight formula (`START * 1100 + 256 + 3072` MB) and the timeouts
in `run.sh`. These are estimates from the constants, not measurements.

| Case | Nodes | Available RAM the preflight needs | Docker memory caps (not all used) | Time |
|---|---|---|---|---|
| `halt-n10s10` | 10 | 14,328 MB (14.0 GiB) | 10 x 1800 MB + 1 GB | about 12-16 min: genesis delay 310 s, baseline and one more block, settle 20-50 s, hold about 130 s, recovery 1-5 min, teardown |
| `halt-n13s10` | 13 | 17,628 MB (17.2 GiB) | 13 x 1800 MB + 1 GB | about 13-17 min: genesis delay 385 s, then as above |
| `ride-n13s10` | 13 | 17,628 MB (17.2 GiB) | 13 x 1800 MB + 1 GB | about 10-14 min: genesis delay 385 s, then up to `RIDE_TIMEOUT` (300 s) for 5 blocks, no restart |

Disk: the preflight needs 10 GB free on `/` (`MIN_DISK_GB`). Node and
postgres state are on tmpfs, so they count as RAM; the run's own disk use is
the 13 container logs and the run dir, which has not been measured.

## Runs and logs

Everything goes to `runs/<UTC time>-<scenario>-<binding>-<label>/`
(gitignored, mode 700): `inputs/` (identities, genesis, peerlist, compose
file: devnet keys, never commit them), `logs/01-preflight.log` ..
`05-verdict.log` per step, `events.log` with a timestamped line per stop,
start and partition change, `node-N.log` (full container logs, collected at
teardown), `phases.tsv` (per phase: validators down and live, height range,
blocks, mean and longest gap between block timestamps, outcome),
`verdict.json` and `run.log` with the whole run. The `halt-*` and `ride-*`
drills also leave `drill-input.json` (what the run observed),
`drill-verdict.json` and `logs/judge.out` (the judge's report and its
`DRILL_TIMINGS` line); `verdict.json` then carries the judge's verdict under
`drill`.

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
- The node runs as the image's user (`demos`, uid 1000 in the release image),
  and Docker creates a tmpfs root-owned. `run.sh` reads the uid and gid from
  `${IMAGE}` and mounts the node's `/app/state` as
  `/app/state:uid=<uid>,gid=<gid>,mode=0700`; the preflight mounts a tmpfs with
  the same string in a throwaway container and copies, restricts and reads the
  identity there as that user. Everything else the node writes (`/app`,
  `/app/data`, `/app/logs`) is an image directory the Dockerfile chowns to it.
- A trap collects the logs, removes the sidecars and runs
  `docker compose down -v --remove-orphans` on any exit, including Ctrl-C.

## Tuning

`CONSENSUS_TIME` (10), `GENESIS_DELAY` (60 + 25 s per node),
`LOCKSTEP_TIMEOUT` (420), `PROGRESS_BLOCKS` (3), `PROGRESS_TIMEOUT` (180),
`STALL_WINDOW` (120), `PARTITION_TIME` (120), `SETTLE_TIMEOUT` (300),
`READ_TIMEOUT` (8, the curl timeout in seconds of the one retry after an
empty or timed-out read of a node's head or hash during the lockstep waits),
`NETSHOOT_IMAGE`, `RUNS_DIR`. For the `halt-*` and `ride-*` drills:
`BASELINE_HEIGHT` (6), `SETTLE_ROUNDS` (2), `HALT_ROUNDS` (12),
`RECOVERY_BLOCKS` (3), `RECOVERY_TIMEOUT` (300), `RIDE_BLOCKS` (5),
`RIDE_TIMEOUT` (300); the first five are scenario 12's values. The judge
needs `HALT_ROUNDS` samples, so lowering it only shortens the hold window.

## Notes

- The lockstep wait reads every node's head at once (one background job per
  node, each with the timeout and one retry above). It holds at height `h`
  when every running node answered, `max(head) - min(head) <= 1`, and every
  node returns the same non-empty hash at `h = min(head)`; the drills use that
  `h` as their baseline and pre-stop height. A sequential read of 13 loaded
  nodes can span a block boundary, which a requirement of equal heads cannot
  survive. `fallback` and `partition` need every node on one head and wait for
  exactly that. Window: `max(120, 60 + 10·N)` s. `lockstep-stub.test.sh` runs
  the wait against a fake `rpc`.
- Gossip is off by default, as in the race harness; `GOSSIP_ENABLED=true`
  turns it on. With gossip off, a node learns that a peer is ahead only
  from that peer's block push: a sync claim above our own height is
  discarded until it can be checked. That default is unchanged for the
  scenarios other than `halt-n10s10`, `halt-n13s10` and `ride-n13s10`; those
  three always run with `GOSSIP_ENABLED=true`, whatever the environment says
  (`run.sh`), because with gossip off a restarted node never sees that the
  network is ahead (`Sync.ts:129-136`, `networkAheadVeto.ts:59`) and the
  recovery result would measure that, not the halt. Gossip needs the sidecar
  (`node sidecar/dist/gossip-sidecar.mjs`, started by the node process itself
  from `/app`, so under either start path): the preflight aborts when the image
  has no bundle or its `node` is not a real Node.js >= 20 (a devnet-style
  image has Bun's wrapper), so those three cases need a release image.
- Validators are stopped with `docker compose stop -t 0` right after a
  round start is logged, so the restart policy leaves them down.
- Round times come from block timestamps, so they show the chain's own
  pace, including retries at a height.
