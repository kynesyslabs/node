---
type: runbook
title: Timed backup / wipe / restore drill (devnet)
date: 2026-11-04
status: draft
---

# Timed backup / wipe / restore drill (devnet)

Mainnet-launch #16, part G16-b. A script that backs up one validator of a
throwaway 4-node devnet, wipes its database, restores it, and times each step.
It runs on a devnet only: no transaction is sent anywhere, and every key is
generated for the run.

Script: `testing/devnet/backup-restore-drill/run.sh`
(compose file: `gen-compose.py` next to it).

## What it shows, and what it does not

It shows that a `pg_dump -Fc` of a validator's database restores into an empty
database, that the validator rejoins from it with its identity and signing
state untouched, and how many seconds each step takes. By default the devnet
runs the launch fork set (`FORK_SET=launch`): the forks
`docs/mainnet/genesis.template.json` activates at height 0, without
`identityCarryover` (it needs a genesis snapshot, which the drill does not
have). `FORK_SET=devnet` runs the forks of `testing/devnet/genesis.devnet.json`
instead. The fork set and every fork's height are logged at the start of the
run and written to `timings.md` and `timings.json`; a result holds for that
fork set only.

It does not show:

- that the production `docker-compose.yml` volumes behave the same (this drill
  has its own compose file);
- losing the identity volume: not covered by this drill; see
  `validator-key.md`, section "Signing state files";
- the production start guards: the drill nodes run with `NODE_ENV=development`,
  without `PROD=true` and without `DEMOS_REQUIRE_VALIDATORS`, so those guards
  are not exercised.

## Before you run it (host3)

- `docker` with the compose v2 plugin, `jq`, `python3`, `awk`. `bun` on the
  host is optional: without it the identities are generated inside the node
  image (`IDENTITY_GEN=image`).
- The two images must already be on the host. The script never pulls and never
  builds. Images used, and no others:
  1. `NODE_IMAGE`: a prebuilt local node image (default
     `demos-node:candidate-5979a716`, the quorum drills' default).
  2. `PG_IMAGE`: `postgres:16-alpine` (the quorum drills' tag; set it to the
     digest-pinned form used by `docker-compose.yml` to match production). It
     is also the image of the one-off helper containers (busybox `sh`,
     `sha256sum`, `tar`).
- Outbound UDP 123 from containers: lets each node measure its clock offset at
  start; it is not needed to start. At start the node asks four public NTP
  servers (`checkClockAtBoot` in `src/libs/utils/clockProbe.ts`). If none
  answers, or fewer than two agree within 2 s of each other, it logs the
  warning `[CLOCK] Host clock offset not measured` and starts on the host
  clock. It refuses to start only when two or more agreeing servers put the
  host clock more than 5 s (`COSIGN_TIMESTAMP_MAX_LEAD_SECONDS`) ahead or
  behind, and only with `PROD=true`; the drill nodes run without it, so they
  log that as an error and start anyway. If a node does not serve, read its
  log first: `logs/node-N.log` in the run dir (written at teardown).
- Host ports `BASE_PORT+1 .. BASE_PORT+5` free, on 127.0.0.1 only. Default
  `BASE_PORT=65000`; the script refuses a range touching 640xx or 643xx.
- Disk and RAM: the same preflight as `quorum-drills/run.sh` (10 GB disk,
  about 1.1 GB per node plus 150 MB per postgres plus 3 GB headroom). Four
  nodes at the 1800m cap each plus four postgres at 512m.
- umask: host3 runs with umask 0077 and the release image runs as uid 1000.
  The script makes everything a container reads (identities, genesis,
  peerlist, the copied `l2ps/` dir) mode 644/755 inside its 700 run dir, then
  proves it with `docker run --user 1000 ... test -r` on the exact mounts, and
  stops with a clear message if that fails. The identities are throwaway
  devnet keys, are deleted at the end (`KEEP_KEYS=1` keeps them), and are never
  printed.
- Writable state: the same user (uid 1000) writes the node-state volumes, so
  they must be owned by it; a root-owned named volume or tmpfs makes the node
  die with `cp: cannot create ... Permission denied`. Before anything timed
  starts, the script creates the volumes (`compose up --no-start`), then runs
  `docker run --user 1000 -v <volume>:<path in the node> --entrypoint sh
  NODE_IMAGE -c 'touch .../.w && rm .../.w'` for each named volume and tmpfs
  the node services mount read-write (the state volumes, `/app/state`), and
  for the image's own writable directories (its declared volumes, `/app/data`
  and `/app/logs`, and its working directory). The probe mounts the volume
  where the node gets it, so a new volume takes the owner of that directory in
  the image, as in the real run. If any probe fails the script stops with the
  list, before any node starts, and changes nothing. `FIX_OWNERSHIP=1` is the
  opt-in: it chowns `1000:1000` (recursively) only the volumes of this compose
  project (`${PROJECT}_*`, checked by label) that failed, and probes again. The
  wipe (phase B) runs as root and only deletes; it never creates anything on
  the state volume. It records owner and mode of the state dir and the
  identity files before and after (check "the wipe kept the ownership of the
  state volume") and probes uid-1000 writability of the state volume again
  before the restart. The postgres and backup-staging volumes are postgres's,
  not uid 1000's, and are not probed.
- Gossip: on every node, by default (`GOSSIP_ENABLED=true` in the generated
  compose file). A validator with gossip off never catches up after a restart
  (it logs "already synced" while behind), which would wreck the restore
  timings, so the script refuses to start without it: it reads the generated
  compose file, and if any node has `GOSSIP_ENABLED` other than `true` it stops
  and says why, unless `ALLOW_GOSSIP_OFF=1`. A deliberate negative run is
  `GOSSIP_ENABLED=false ALLOW_GOSSIP_OFF=1` (a warning, and an INFO row in the
  checks). With gossip on, the image must have `node` (>= 20) on the PATH of a
  login shell, because the gossip sidecar is spawned as `node`; the script
  checks that too.

## Invocation

Smoke check, minutes: run this before the full drill (see below).

```
NODE_IMAGE=<local image> BASE_PORT=65000 SMOKE=1 \
  testing/devnet/backup-restore-drill/run.sh
```

Wipe and rejoin (the main drill):

```
NODE_IMAGE=<local image> BASE_PORT=65000 \
  testing/devnet/backup-restore-drill/run.sh
```

Restore into an isolated, non-signing node:

```
NODE_IMAGE=<local image> BASE_PORT=65000 VARIANT=isolated \
  testing/devnet/backup-restore-drill/run.sh
```

The script re-executes itself under `nice -n 10`, and waits until the 1-minute
load is under 18 (up to 30 minutes, then exits 2). It does not need to be
started under `nice` by hand; wrap it in `nohup`/`tmux` if the SSH session may
drop (the run time has not been measured: genesis delay alone is 160 s).

Exit codes: 0 every check passed, 1 a check failed, 2 the drill could not be
carried out (preflight, boot, timeout, a step that must work failed), 3 every
check passed but the teardown failed or left something of the project (see
Output). A run that exits 1 or 2 keeps that code when the teardown fails too.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `NODE_IMAGE` | `demos-node:candidate-5979a716` | prebuilt node image |
| `PG_IMAGE` | `postgres:16-alpine` | postgres and helper image |
| `BASE_PORT` | `65000` | host ports `BASE_PORT+1..+5`, 127.0.0.1 |
| `PROJECT` | `demos-bkdrill` | compose project; must start with `demos-`; the run aborts if a container or volume of that project, or a volume with any name the compose file declares (labelled or not), already exists |
| `VARIANT` | `rejoin` | `rejoin` or `isolated` |
| `OUT_DIR` | `testing/devnet/backup-restore-drill/runs/<UTC>-bkdrill-<variant>` | everything the run writes (mode 700, gitignored) |
| `X_NODE` | `4` | the drilled validator (2..4; 1 is the peerlist anchor) |
| `SHARD_SIZE` | `4` | genesis shardSize; q = floor(2 * shardSize / 3) + 1 |
| `H0` | `5` | all four nodes must reach this height before the backup |
| `CONSENSUS_TIME` | `10` | as the quorum drills |
| `NODE_MEM` / `PG_MEM` | `1800m` / `512m` | container memory caps |
| `CPU_SHARES` | `256` | compose `cpu_shares` (default weight is 1024): containers yield to other work under contention |
| `LOAD_MAX` / `LOAD_WAIT_MAX` | `18` / `1800` | start only when the 1-minute load is below `LOAD_MAX`; give up after `LOAD_WAIT_MAX` s |
| `STOP_GRACE` | `10` | seconds `compose stop` waits before killing node X |
| `STALL_LIMIT` | `90` | longest allowed gap, in seconds, between head increases on the other nodes |
| `BRINGUP_TIMEOUT`, `SERVE_TIMEOUT`, `REJOIN_TIMEOUT`, `SIGN_TIMEOUT` | `900`, `240`, `420`, `300` | step timeouts in seconds |
| `MIGRATE_CMD` | `bun run migration:run` | the one command that applies pending migrations, run in a one-off container of `NODE_IMAGE` (see below) |
| `MIGRATE_REQUIRED` | `1` | a failing migration on the restored database aborts the drill |
| `MIGRATE_TIMEOUT` | `300` | seconds one migrate run may take; then it is stopped, logged as timed out, and counts as failed |
| `FORK_SET` | `launch` | genesis fork schedule, passed to `quorum-drills/gen-inputs.py --fork-set`: `launch` (the forks `docs/mainnet/genesis.template.json` activates at 0, without `identityCarryover`) or `devnet` (those of `testing/devnet/genesis.devnet.json`); logged at the start, in `timings.md` and in `timings.json` |
| `ISO_NODE` | `1` | in `isolated`, also start a non-signing node on the restored database |
| `KEEP_KEYS` | `0` | `1` keeps the identity inputs after the run |
| `IDENTITY_GEN` | `auto` | `host` (bun on the host), `image` (inside `NODE_IMAGE`), or `auto` |
| `GOSSIP_ENABLED` | `true` | `true` or `false`, for every node; `false` is refused unless `ALLOW_GOSSIP_OFF=1` |
| `ALLOW_GOSSIP_OFF` | `0` | `1` lets a run with gossip off start (a negative run); it warns and records an INFO row |
| `FIX_OWNERSHIP` | `0` | `1` chowns `1000:1000` the drill's own volumes (`${PROJECT}_*`) the uid-1000 probe found unwritable, instead of stopping |
| `SMOKE` | `0` | `1` runs the startup check only (below) |
| `SMOKE_TIMEOUT` / `SMOKE_HEAD` | `300` / `2` | smoke: seconds to wait, from the first node start, for every node to serve RPC at head >= `SMOKE_HEAD` |

## Smoke check (`SMOKE=1`)

The seconds-to-minutes startup check to run before the full drill, on the same
image and host. It runs the preflight (tools, load wait, disk and RAM, images
local, the uid-1000 read check of the inputs, the gossip check, the uid-1000
write check of the node state), starts the 4 postgres, applies the migrations,
starts the 4 nodes one at a time, and waits (cap `SMOKE_TIMEOUT`, 5 minutes)
until every node answers RPC with a head of at least `SMOKE_HEAD`. It then
prints `SMOKE PASS` or `SMOKE FAIL`, tears the project down and exits: 0 pass,
1 a node did not make it (each node gets a row; a failing one names its log,
`logs/node-N.log` in the run dir, written at teardown, and the last 15 lines are
printed), 2 the preflight or a postgres failed, 3 pass but the teardown failed
(see Output). No backup, wipe or restore
runs, and there is no isolated node. Genesis is set `GENESIS_DELAY` (160 s by
default) after the inputs are made and the cap counts from the first node
start; none of this has been timed on Docker yet, so if a healthy host needs
more than 5 minutes, raise `SMOKE_TIMEOUT`.

## What it does

Devnet: 4 validators, each with its own postgres (data in a named volume) and
its own state volume at `/app/state` holding the identity and signing state.
Genesis, peerlist and fork schedule (`--fork-set`, from `FORK_SET`) come from
`quorum-drills/gen-inputs.py` unchanged; only the compose file is different
(persistent volumes instead of tmpfs, one postgres per node, an isolated node,
a one-off `migrate` service).

How a node is started: through the image's own start command, without its
entrypoint script. The release image has `ENTRYPOINT
scripts/docker-entrypoint.sh` and `CMD bun -r tsconfig-paths/register
src/index.ts -- --no-tui`; the compose file replaces the entrypoint with a
short shell that makes `/app/state`, puts the identity on the state volume if
it is not there, uses `./testing/devnet/run-devnet` when the image has it (the
devnet image's entrypoint), and else `exec`s that same CMD. What
`docker-entrypoint.sh` would add (symlinks for `.demos_identity`,
`demos_peerlist.json`, `.tlsnotary-key`, `output/`, and the signing record when
`IDENTITY_FILE` is outside the state dir) is not needed here: `IDENTITY_FILE`
is on the state volume with its signing record, the peerlist is only read (from
a read-only mount that the script's `mv` could not move), TLSNotary is off, and
`output/` is written only by the backup utility. Read from the sources, not
run on Docker; the reasoning is in `gen-compose.py` above `START_SCRIPT`.

1. Preflight: tools, load wait, disk, RAM, no swapping, project name unused,
   ports free, images local, uid-1000 readability of the inputs, gossip on
   (and `node` in the image), uid-1000 writability of the node state.
   "Project name unused" means no container or volume carries the project's
   compose label and, before the first `compose up`, no volume exists with
   any of the exact names the generated compose file declares
   (`<project>_state-4`, `<project>_pgdata-1`, ...), whatever its labels.
   Compose would use such a volume and teardown's `down -v` would delete it,
   so the run names the ones it found and exits 2 without creating any
   container or volume.
2. Bring-up: postgres x4, migrations on each database (manual step, see
   below), nodes one at a time, wait until every node is at height `H0`.
   Record node X's head height and block hash, and the SHA-256 of its identity
   file and signing state files (`node.identity`, `.signed.json`,
   `.commitlock.json`, `.prevote.json`; the `.lock` beat file is left out).
   Only hashes and heights are printed; no file content is.
3. **A** backup: stats, `pg_dump -Fc` inside node X's postgres container into
   a staging volume, stats again, `pg_restore --list` and `sha256sum` on the
   dump. The database only: the identity and signing state files are not
   copied, they stay on node X's state volume, which the wipe keeps. Backing
   them up is `validator-key.md`, section "Signing state files".
4. **A2** copy the staging volume to `$OUT_DIR/backup/` on the host
   (`docker cp`), check the SHA-256 there.
5. **B** wipe (`rejoin`): stop node X, read its true head from its database,
   hash the signing state at rest, remove the node container, the postgres
   container, the database volume and the staging volume, and delete
   everything on the state volume except `node.identity*` (the drill's
   `IDENTITY_FILE` is `/app/state/node.identity`). If the delete fails, or
   the state volume then holds anything whose name does not start with
   `node.identity`, the run stops with exit 2 before node X is started
   again. The wipe uses no `--reset`, no reset-node script and no `down -v`;
   `down -v` runs only at teardown, on the drill's own project (see Output).

   **Drill volumes only.** A validator's state volume holds `.demos_identity*`
   files, which this wipe would delete. On a bare-metal install use
   `scripts/reset-node` (it keeps the signing record unless
   `--wipe-signing-state`). On Docker, never delete the state volume's
   `.demos_identity*` files and never run `down -v` on a validator's project;
   see `validator-key.md`.
6. **C** restore: assert no container holds node X's state volume, start an
   empty postgres, `pg_restore --no-owner --exit-on-error` of the whole dump
   from the host copy, stats, migrations, assert again, start exactly one
   node X. Ends when its RPC serves.
7. **D1 / D** rejoin: D1 is the time from "serving" until its head is within
   2 blocks of the other three. D adds proof that it signs: its signing record
   height moves past the value at stop, or a block after the restart carries
   its signature. Row **ALL** is stop of node X to rejoined and signing (the
   outage as an operator sees it).
8. Checks (below), the timings table, teardown.

`VARIANT=isolated` runs 1 to 4, leaves node X running, restores the dump into
a new postgres, applies migrations, compares counts with the dump, and (with
`ISO_NODE=1`) starts a node with no identity mounted, outside the validator
set, on the restored database. Node X's key is never mounted anywhere else.

## Checks

Each is printed PASS, FAIL or INFO, and written to `timings.md` and
`timings.json`.

| Check | Passes when |
|---|---|
| restored head >= pre-wipe head | head after the rejoin >= head read from the database at stop |
| block hash at pre-wipe heights | node X's hash at the step-2 height and the at-stop height equals each other node's, and equals what was recorded |
| identity file checksum | identical at step 2, at stop, and after the rejoin |
| signing state | every signing file present at stop still exists; `.signed.json` and `.prevote.json` heights never lower. The detail says per file `unchanged` or `advanced` |
| no halt marker | no `*.halted` on the state volume, no foreign-signature line in node X's log |
| signing floor | the `Restart signing floor` log line is present (INFO if the wording differs) |
| node X signs | see D above |
| other nodes never stalled | with the devnet's quorum (below), the longest gap between head increases while node X was down is at most `STALL_LIMIT` |
| restored counts match the dump | max block, blocks and transactions inside the before/after window of the dump; `fork_state` and `migrations` rows equal; same table set |
| schema at the image's head | rows in `migrations` equal the migration files in the image's `src/migrations` |
| one instance of the key | asserted before the single start; the run dies if it does not hold |
| gossip enabled on every node | `GOSSIP_ENABLED=true` in the generated compose file (INFO when `ALLOW_GOSSIP_OFF=1` lets it be off) |
| node state is writable by uid 1000 | the probes of "Writable state" above (a failure stops the run before it starts) |
| the wipe kept the ownership of the state volume | owner and mode of the state dir and identity files equal before and after the wipe |

### Quorum

A block needs `floor(2 * shardSize / 3) + 1` signatures. The stock devnet
genesis has `shardSize` 10, so 4 validators would never forge (q = 7; the
`floor` scenario of the quorum drills shows it). This drill sets `shardSize` 4:
q = 3, committee = all 4. While node X is down the 3 others are exactly at
quorum, with no slack: one slow validator stalls the chain, and that would
show as a failed "never stalled" check. Re-run on a quieter host before
reading it as a restore problem.

With `SHARD_SIZE=5` (q = 4, so 4 of 4) the chain pauses while node X is down.
The script detects `live others < q` and reports the check as INFO
`EXPECTED PAUSE` with the observed gap instead of FAIL.

## Output

In `$OUT_DIR`: `timings.md` and `timings.json` (phases, checks, run metadata),
`logs/run.log` and one log per step, `logs/node-N.log` (and
`node-4.pre-wipe.log`), `logs/monitor.tsv` (the other nodes' head every 5 s),
`backup/` (dump, SHA-256, before/after counts), `phases.tsv`, `checks.tsv`.
On exit, including on Ctrl-C or an error, teardown tries to remove the
`demos-bkdrill` compose project: it removes the helper containers that carry
the label `demos.drill.helper=<project>` and runs `compose down -v` for that
project only. When it works, this removes the drill's own volumes, node X's
state volume with its throwaway key included. Preflight refuses to start when
a volume with one of the declared names already exists (step 1), so the named
volumes `down -v` deletes are ones this run created.

Teardown then lists the containers, volumes and networks that still carry the
label `com.docker.compose.project=<project>` and prints the counts. If
`down -v` exits non-zero, a listing fails, or anything is left, it prints
`CLEANUP FAILED` with the reason, writes the same as `cleanup` in
`timings.json` and as `cleanup: **FAILED**` in `timings.md` (`result` keeps
the drill's own verdict), and exits 3 instead of 0. Then check, with Docker
working again (`demos-bkdrill` or your `PROJECT`):

```bash
docker ps -a --filter label=com.docker.compose.project=demos-bkdrill
docker volume ls --filter label=com.docker.compose.project=demos-bkdrill
docker network ls --filter label=com.docker.compose.project=demos-bkdrill
```

and read `logs/teardown.log`. Teardown's own command can be run again by hand:
`docker compose -f $OUT_DIR/compose.yml -p demos-bkdrill down -v --remove-orphans`.
A next run on the same project refuses to start while a container or volume of
it is left.

## Testing the script itself

`testing/devnet/backup-restore-drill/test/run-fake-tests.sh` runs `run.sh`
against a fake `docker` (`test/fake-bin/`): the gossip default and refusal,
unwritable volumes (fail fast, `FIX_OWNERSHIP=1`), `SMOKE=1` pass and fail,
the fork set `gen-inputs.py` gets (default `launch`, `FORK_SET=devnet`), the
migrate step on the restored database (after `pg_restore` and before node X
starts; a failure or a timeout stops the run with exit 2 and node X is not
started), a volume that exists before the run under a name the compose file
declares (exit 2, no `up`, no `down`, the volume untouched), a wipe that fails
or leaves an entry (exit 2, node X not started again), a teardown whose `down`
fails or leaves a volume (exit 3 after a pass, the failure in `timings.json`
and `timings.md`), and a full `rejoin` and `isolated` run. It needs no Docker and tests
the script's own logic only; it says nothing about what a real image, volume
or postgres does.

## Manual migrations

The drill applies migrations itself, as the G16-a change needs
(`migrationsRun: false`, `docs/runbooks/database-migrations.md`): on every
database before the nodes start, and on the restored database before node X
starts. It runs `MIGRATE_CMD` in a one-off container of `NODE_IMAGE`, with
`PG_HOST` and `PG_DATABASE` pointed at that database. The default,
`bun run migration:run`, is the repo script (`package.json`); set `MIGRATE_CMD`
to whatever the migrations runbook settles on. At bring-up a failing migration
is a warning (a node that still migrates at boot does not need it); on the
restored database it is fatal unless `MIGRATE_REQUIRED=0`. Each run is stopped
after `MIGRATE_TIMEOUT` seconds (300 by default; `timeout -k 10`: TERM, then
KILL 10 s later), logged as `migrations on <database> timed out`, and counts
as a failed migration.

The default command has not been run against the default image. The first
real run on the chosen image must show the migrate step passing: no
`WARNING: migrations on node N's database failed` line in `logs/run.log`, and
the check "schema at the image's head" PASS. If it fails, set `MIGRATE_CMD` to
a command the image can run, for example the TypeORM CLI form that
`quorum-drills/run.sh` uses:

```
MIGRATE_CMD='bun -r tsconfig-paths/register ./node_modules/typeorm/cli.js migration:run -d ./src/model/datasource.ts'
```

## Things to read in the result

- Phase B includes up to `STOP_GRACE` seconds of waiting if the node ignores
  SIGTERM. The devnet image probably does (`run-devnet` is a shell script
  running as PID 1 with no TERM trap; unverified): the script logs the exit
  code, and 137 means it was killed after the grace period. With the release
  image the script starts the node directly, as PID 1.
- After a stop that was not clean, the identity lock (`node.identity.lock`) is
  replaced after a 10 to 25 second watch (`validator-key.md`); that time is
  inside C or D.
- The restore is a head start. The node still has to sync the blocks produced
  while it was down; D1 is that time.
- A dump, however fresh, may be older than the head the node had: compare
  `head_at_stop` with `dump_head_window` in `timings.md`.
