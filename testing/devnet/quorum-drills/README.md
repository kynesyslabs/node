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
  the same code. `quorumParity` is active from block 0 in both. **`off` does
  not currently work:** `genesis.devnet.json` also activates `commitLock` at
  0, and the node's fork loader refuses a genesis that has `commitLock`
  without `committeeBinding` (`src/forks/loadForkConfig.ts:277-288`). Loading
  the generated `--binding off` genesis with `loadForkConfigFromGenesis` gives
  that error; a node boot was not run. The three mainnet-shape cases take
  `--binding on` only.

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
run, `genesisPin.ts:56-68`), postgres and `/app/state` on tmpfs, the generated
genesis and the empty snapshot, `OMNI_MODE=HTTP_ONLY`, TLSNotary off, and no
published ports.

### What differs from mainnet: identityCarryover

`identityCarryover` is **off in the drills** and is at 0 in the mainnet genesis
template (`docs/mainnet/genesis.template.json`). On mainnet every validator
needs the genesis snapshot (a manifest and files matching the
`snapshot.manifestSha256` in block 0's genesis, in `data/snapshot` or
`DEMOS_SNAPSHOT_DIR`) on **every** boot, every restart and every rebuild of its
database:

- **Fresh database or rebuild.** No snapshot is a refusal
  (`src/libs/blockchain/genesis/restoreGenesisState.ts:58-66`), and so is a
  genesis without `snapshot.manifestSha256`, a missing manifest or a manifest
  that hashes differently (`routines/findGenesisBlock.ts:212-220`,
  `genesis/genesisPin.ts:165-184`). The snapshot is loaded and verified file by
  file (`genesis/loadSnapshot.ts:431`) and `assertCarryoverSnapshot` checks it
  before the database transaction opens (`restoreGenesisState.ts:71-73`).
- **Every restart.** The node reads the stored block 0, and if it schedules
  `identityCarryover` at 0 it opens the snapshot again: no manifest, a manifest
  that does not hash to block 0's value, or a `gcr_main.jsonl` that does not
  match the manifest stops the boot, as does an imported-identity registry that
  differs from the snapshot (`routines/findGenesisBlock.ts:181-192`,
  `genesis/verifyImportedIdentities.ts:40-77`, `genesis/loadSnapshot.ts:528-562`).
  A restart does not re-hash the other snapshot files.

The drills **do not cover any of this**: they run the legacy genesis path with
an empty snapshot directory, so the snapshot check, the carried-over identities
and the apply-time rules of the fork (no first-link award for an imported
identity, web2 unlink by `userId`) are not exercised. A launch rehearsal that
needs them has to build a snapshot and mount it, which these drills do not do.

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
crashed node must not pass for a stalled one, and neither may a run in which
Postgres ran out of connections (see "Postgres connections"). Each run with a verdict
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

### Fork set

Scenario 12 and these three cases run the forks `docs/mainnet/genesis.template.json`
launches with, read from that file when the drill starts: a fork is active at
0 if its `activationHeight` there is the number `0`; `null` and `"FILL: ..."`
stay off. The genesis `forks` object is replaced as a whole, so no fork is left
to a default (`osDenomination`, `nonceEnforcement` and `gasFeeSeparation`
default to 0, `src/forks/forkConfig.ts:405-423`, `466-477`), and a template
that stops activating `quorumParity`, `committeeBinding` or `commitLock` is an
error. The code is `launch_fork_heights` and `with_launch_forks` in
`drill_inputs.py` (`run.sh` through `gen-inputs.py --fork-set launch`; scenario
12 through `withLaunchForks`). The template has 10 forks at 0 now; the drills
run 9: `osDenomination nonceEnforcement signatureDomain editBinding
nonceIntegrity quorumParity committeeBinding commitLock finalityProofs`.
`identityCarryover` is at 0 in the template and **excluded by name** (the
`LAUNCH_EXCLUDED_FORKS` list in `drill_inputs.py`, one reason per fork): the
drills mount an empty `data/snapshot`, and a node with `identityCarryover`
active at 0 and no snapshot refuses to boot (see
[What differs from mainnet](#what-differs-from-mainnet-identitycarryover)). It
is written into the drill genesis as `activationHeight: null`, also when the
template does not list it. `gasFeeSeparation`, `web2ProofBinding`,
`tlsnProofEnforcement`, `xmProofBinding` and `atomicWork` are off
(`gasFeeSeparation` keeps a treasury address, which the loader wants even when
the fork is off). The genesis has all 15 forks of the template.

If the template ever sets another fork to 0 that needs a snapshot, add it to
that list. Until then a drill with it active does not run: no node serves, and
`run.sh` ends the bring-up as `ABORT: node-N did not serve within 180s` (exit
2) followed by `node-N log: ...`, the node's last `Refusing to boot` line
(`boot_failure_line`; the full log is kept in `node-N.log`). Scenario 12 times
out on its baseline height (exit 1, `scenario.ts`) and appends the same line to
the error. Neither run produces a verdict. Neither has been run against a real
refusal here; the line extraction is tested against stubs.

`run.sh` logs the set (`forks (launch): ...; excluded: identityCarryover
(needs a genesis snapshot; the drills use the legacy genesis path)`, and
scenario 12 the same in its fork-set line), and `drill-input.json`,
`DRILL_TIMINGS` and `drill.timings.forks` in `verdict.json` carry every fork of
the genesis the nodes ran. The excluded forks are in `DRILL_TIMINGS` and
`drill.timings.excludedForks` too, and `run.sh` writes them to `verdict.json`
as `excludedForks`. The other scenarios keep the forks of
`genesis.devnet.json` (nine launch forks and `gasFeeSeparation`, all at 0, plus
the two `gen-inputs.py` sets); their generated compose, genesis and output are
byte-identical to before.

What the drill genesis has to provide for the forks that were not all on
before (scenario 12 had `osDenomination` at 5 and none of `signatureDomain`,
`editBinding`, `nonceIntegrity`, `finalityProofs`; the quorum cases already
inherited all nine from `genesis.devnet.json`, so there only `gasFeeSeparation`
is new, and off):

- **`finalityProofs`** draws the pool from the validator set snapshot after
  block B-2 and throws `no validator set snapshot at or below block N` without
  one (`getShard.ts:83-101`); a block commits its parent's snapshot hash
  (`finality/commitments.ts:215-225`, `248`). The snapshot is a row of
  Postgres' `validator_set_snapshots`, not a file, so the empty
  `data/snapshot` mount does not matter. Block 0's row is written at boot:
  with no snapshot manifest `loadSnapshot` is unavailable
  (`genesis/loadSnapshot.ts:445-451`), `restoreGenesisState` returns false
  (`genesis/restoreGenesisState.ts:58-66`; with `identityCarryover` off, as in
  the drills, it neither refuses nor restores), `generateGenesisBlock` takes
  the legacy path and seeds no validators (`chainGenesis.ts:71-85`),
  `ensureValidatorSeed` then seeds them from `genesis.json` at block 0
  (`index.ts:605`, `routines/ensureValidatorSeed.ts:119-151`) and
  `ensureValidatorSetSnapshot(0)` records the set (`index.ts:607`,
  `finality/validatorSet.ts:142-164`). Every later block adds a row only when
  the set changed (`chainBlocks.ts:553-560`, `validatorSet.ts:71-89`), so the
  one row at block 0 answers every height here. A restarted node keeps its
  database; its boot check wants a row at or below tip-1
  (`validatorSet.ts:128-140`), which is that row.
- **`osDenomination`** runs its migration when block 0 is inserted
  (`chainBlocks.ts:414-428`), as on every fresh chain (its default is 0).
- **`signatureDomain`** needs `properties.id` to be an integer
  (`loadForkConfig.ts:201-209`, `255-263`; `signatureDomainGate.ts:36-52`);
  `genesis.devnet.json` has 1337 and `genesis-fork-low.json` has 1. Nothing in
  the node refuses those ids (only `scripts/launch-go-no-go.ts:185` does, for a
  real launch).
- **`nonceEnforcement`, `editBinding`, `nonceIntegrity`** act on transactions
  (`handleGCR.ts:1155-1163`, `2026-2030`, `mempool.ts:582`, `643`,
  `validateTransaction.ts:111`, `editBinding.ts:135-146`). The drills send none:
  `run.sh` makes only `getLastBlockNumber` and `getBlockByNumber` calls
  (`run.sh` `head_of`, `block_req`) and reads the databases, and scenario 12
  reads heads and `blocks` rows.

Loading the generated genesis of all three launch cases and of scenario 12 with
`loadForkConfigFromGenesis` accepts it and activates exactly the nine, with
`identityCarryover` loaded as null (checked again after the merge of
stabilisation 891c1e7b38, on the `genesis-fork-low.json` and
`genesis.devnet.json` bases; it is a unit test now,
`drillInputs.test.ts`).

### Which validators are stopped

With `committeeBinding` active (block 0 here, `gen-inputs.py`; `--binding on`)
and `finalityProofs` active as well (both are in the launch fork set, see
[Fork set](#fork-set)), read from `src/libs/consensus/v2`:

- **Pool.** The committee for block B is drawn from the peerlist committed in
  block B-1, intersected with the staked set (`routines/getShard.ts:165-201`,
  `chainEligiblePool`; the rule is `eligiblePoolFrom`, `routines/poolRules.ts:37-56`).
  Under `finalityProofs` the staked set is the validator set snapshot after
  block B-2, not the live table (`getShard.ts:83-101`, `poolValidatorAddresses`):
  a join or exit reaches the pool one block later. The drill has no joins or
  exits, so the set is the genesis validators throughout and the pool
  arithmetic below is the same as before the fork. Only when the pool holds
  fewer than q = 7 identities does it become the whole staked set
  (`getShard.ts:272-296`, `getBoundPool`; `poolRules.ts:64-71`, `boundPoolFrom`);
  at a block without a peerlist (block 0) it is the staked set
  (`getShard.ts:40-42`, `poolRules.ts:49-51`). It is not all staked validators
  in the normal case.
- **Draw.** The pool is ranked with `Alea(seed)` and the first `shardSize`
  identities are the committee (`getShard.ts:251-261`, `315-321`). The seed
  is the common validator seed of the parent block (`getShard.ts:332-345`), so
  which validators are drawn is not known before that block exists.
- **Offline members are not filtered out.** They stay in the committee and
  count as missing votes (`getShard.ts:323-330`, `372-376`, `413-415`,
  `448-473`; `boundCommittee.test.ts:266`, "does not replace an offline
  member"). Only the pre-fork path drops them and takes the next live
  identity (`getShard.ts:417-420`; run with `--binding off` to see it, but
  see the note under `--binding`).
- **What a block needs.** 2/3 + 1 of shardSize = 7 signatures
  (`quorum.ts:10-12`, `19-27`), counted only from committee members
  (`src/libs/blockchain/validation/verifyBlock.ts:139-151`, `165-209`). A
  producer commits on the same bar (`PoRBFT.ts:1424-1431`).
- **What the next pool is.** The committed peerlist lists the identities that
  at least 7 committee voters saw at the parent block
  (`routines/peerlistMerge.ts:211-259`, `273-320`; the bar is `quorumThreshold(shardSize)`
  at `:287-289`). A voter counts a peer only if its last known sync state is
  exactly the parent block (`peerlistMerge.ts:74-100`, `isAtParent` at
  `:281-284`), so a stopped validator drops out of the pool once the chain has
  moved past the height it stopped at; the block right after the stop can
  still list it. (This merge filters its list by the live validators table,
  `:230-232`, where the pool uses the snapshot; the two differ only when the
  set changes.)
- **Secretary and floor.** Only live committee members form the shard; fewer
  than q refuse to forge, and the secretary is the first live member that
  holds our tip, replaced when it goes offline
  (`types/secretaryManager.ts:259-274`, `303-310`, `605-649`).

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

### Postgres connections

Every node's database is on one shared `postgres:16-alpine`; real validators
have a database each. With the default `max_connections` of 100 the 13-node
cases ran out: `FATAL: sorry, too many clients already` in the node logs and in
`run.sh`'s own `psql` read (`ride-n13s10` aborted at its baseline read; the
passing `halt-n13s10` logged it on 11 nodes, so that pass cannot be trusted).

What opens a Postgres connection while a node runs:

| Where | Connections |
|---|---|
| `src/model/datasource.ts:52-68`, the one TypeORM `DataSource` (`Datasource.getInstance`, `:119-125`, is the only caller of `initialize()`; about 40 files go through it, migrations included, `migrationsRun: true` at `:70`) | one pool of up to **10**: no `max` or `poolSize` is set, so TypeORM passes `max: undefined` (`typeorm/driver/postgres/PostgresDriver.js:1205`) and pg-pool uses 10 (`pg-pool/index.js:89`, pg-pool 3.10.1 under pg 8.16.3, typeorm 0.3.31) |
| `src/utilities/backupAndRestore.ts:35`, `new Client` from `pg` | 1, but it is the `bun run restore` tool (`package.json:46`), not started by the node or the image entrypoint |
| a second `DataSource`, `new Pool`, LISTEN/NOTIFY | none in `src/`; the other `new DataSource` calls are in `*Pg.test.ts` files |
| the sidecar (`sidecar/`), `scripts/docker-entrypoint.sh` | none |

So a node holds at most 10. The drill adds its own: `psql_node` (`run.sh`, one
`docker exec psql` at a time) and the healthcheck's `pg_isready` every 2 s
(`gen-inputs.py`), plus 3 slots Postgres keeps for superusers
(`superuser_reserved_connections`, counted inside `max_connections`).

`gen-inputs.py` therefore starts the shared postgres with
`command: ["postgres", "-c", "max_connections=M"]`, **M = 2 x 10 x N + 20**
(`drill_inputs.py pg_max_connections`): N=4 gives 100, N=10 220, N=13 280.
Twice the pools because a node stopped with `docker compose stop -t 0` is
killed and the server drops its backends only when it sees the sockets close,
while the restarted node (`restart: unless-stopped`) is already opening 10
more. The fewest M a run can work with is 10 x N + 20 (N=13: 150).

Memory: `max_connections` reserves nothing by itself. `shared_buffers` stays at
its default 128MB (Postgres needs at least 16kB x M, 4.4MB at M=280) and the
extra shared structures for 280 slots are a few MB. A backend costs memory only
while its connection is open (a node's pool also closes idle connections after
10 s), so the postgres 1g limit and the preflight RAM formula (`START x 1100 +
256 + 3072` MB) are unchanged. Not measured: this has not been run.

Every scenario gets the setting, so the older scenarios' generated compose
differs from before only in the postgres service's `command` (checked by
generating both for N=4, 10 and 13 and diffing them). For 4 nodes, which is
also what the default was:

```diff
     "postgres": {
       "image": "postgres:16-alpine",
+      "command": ["postgres", "-c", "max_connections=100"],
       "mem_limit": "1g",
```

and for `halt-n13s10` (the same line with `max_connections=280`).

A connection-limit hit can no longer pass:

- **Preflight**: after `postgres` is up and before any node starts, `run.sh`
  reads `SHOW max_connections` and ends the run as exit 2, `could not run:
  postgres max_connections is X, N nodes need Y`, if X < 10 x N + 20.
- **Verdict**: before the verdict is written, `run.sh` greps every node's log
  and the log of its own `psql_node` reads (`logs/psql-errors.log`) for `too
  many clients`. Any hit turns a PASS or a FAIL into `ERROR`, exit 2, `could
  not run: postgres connection limit hit (n lines in node-.. node-..); the
  result was PASS`, in `verdict.json` and `results.tsv`.
- **Backstop**: when the logs are collected at teardown, a hit also replaces
  exit 0 or 1 by 2, for the exits that skip the verdict (an early FAIL).

`lockstep-stub.test.sh` covers the preflight and the check against a fake
`docker`; `drillInputs.test.ts` the generated compose for N=4, 10 and 13.

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
`DB_READ_TIMEOUT` (30, seconds a read of a node's database may take: the
server cancels the query after that and an outer `timeout` stops a stalled
exec 5 s later; a read that fails or times out ends the `halt-*` and `ride-*`
runs as `ABORT`, exit 2),
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
  network is ahead (`Sync.ts:133-143`, `networkAheadVeto.ts:59-72`,
  `broadcastManager.ts:369-415`) and the
  recovery result would measure that, not the halt. Gossip needs the sidecar
  (`node sidecar/dist/gossip-sidecar.mjs`, started by the node process itself
  from `/app`, so under either start path): the preflight aborts when the image
  has no bundle or its `node` is not a real Node.js >= 20 (a devnet-style
  image has Bun's wrapper), so those three cases need a release image.
- Validators are stopped with `docker compose stop -t 0` right after a
  round start is logged, so the restart policy leaves them down.
- Round times come from block timestamps, so they show the chain's own
  pace, including retries at a height.
