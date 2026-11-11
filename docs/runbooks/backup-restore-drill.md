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
  are not exercised;
- a bare-metal `./run` node with the launcher's own Postgres container
  (`postgres_<PG_PORT>`, `database-migrations.md`): the drill only uses its own
  compose project;
- an external database: every dump and restore runs as the Postgres image's
  superuser (`demosuser`), and the restore uses `--no-owner`, so a database
  user without superuser rights is not tried;
- a restore across a schema change: the same `NODE_IMAGE` makes the dump and
  migrates the restored database, so that migration has nothing to apply and
  the check "schema at the image's head" passes by construction.

## Before you run it (host3)

- Linux (the load wait reads `/proc/loadavg`), `docker` with the compose v2
  plugin, `jq`, `python3`, `awk`, `grep`, `sed`, GNU coreutils (among them
  `nice`, `timeout`, `sort`, `nproc`, `df`, `date`, `sha256sum`), `find` and
  `xargs` (findutils), `flock` (util-linux), and `free`, `vmstat` and `uptime`
  (procps). `ss` (iproute2) is optional: without it the host ports are not
  checked. `bun` on the host is optional: without it the identities are
  generated inside the node image (`IDENTITY_GEN=image`).
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
  list, before any node starts, and changes nothing. If none fails, the
  results get the INFO row "uid 1000 write probe of the node state", which
  lists the image directories probed. It is not a check and shows nothing
  beyond the paths probed: a path the node writes that is not listed was not
  probed, and when the image's declared volumes cannot be read, only its
  working directory is. `FIX_OWNERSHIP=1` is the
  opt-in: it chowns `1000:1000` (recursively) only the volumes of this compose
  project (`${PROJECT}_*`, checked by label) that failed, and probes again. The
  wipe (phase B) runs as root and only deletes; it never creates anything on
  the state volume. It records owner and mode of the state dir and the
  identity files before and after (check "the wipe kept the ownership of the
  state volume"; a read of them that fails stops the run with exit 2, at stop
  before anything is removed, after the wipe before the restore) and probes
  uid-1000 writability of the state volume again before the restart (a probe
  that fails stops the run). The postgres and backup-staging volumes are postgres's,
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
drop (genesis delay alone is 160 s).

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
| `PROJECT` | `demos-bkdrill` | compose project; must start with `demos-`; the run aborts if a container or volume of that project, or a volume with any name the compose file declares (labelled or not), already exists, or if listing them fails. One run per project at a time: each run holds the lock `$LOCK_DIR/<project>.lock` (`flock`) from before its first check until its teardown has ended, and a second run of the same project exits 2 before it writes anything |
| `VARIANT` | `rejoin` | `rejoin` or `isolated` |
| `OUT_DIR` | `testing/devnet/backup-restore-drill/runs/<UTC>-<project>-bkdrill-<variant>` | everything the run writes (mode 700, gitignored). Must not exist yet: the run creates it with a plain `mkdir` before it writes anything, and one that already exists, even an empty one, is refused with exit 2 and nothing written (it may hold an earlier run's results, or be another run's). The default name holds the project, so runs of different projects started in the same second get different dirs |
| `LOCK_DIR` | `/tmp` | where the per-project lock file lives; `/tmp`, so runs from any checkout or `OUT_DIR` on the host see the same lock (the empty file stays) |
| `X_NODE` | `4` | the drilled validator (2..4; 1 is the peerlist anchor) |
| `SHARD_SIZE` | `4` | genesis shardSize; q = floor(2 * shardSize / 3) + 1 |
| `H0` | `5` | all four nodes must reach this height before the backup |
| `CONSENSUS_TIME` | `10` | as the quorum drills |
| `NODE_MEM` / `PG_MEM` | `1800m` / `512m` | container memory caps |
| `CPU_SHARES` | `256` | compose `cpu_shares` (default weight is 1024): containers yield to other work under contention |
| `LOAD_MAX` / `LOAD_WAIT_MAX` | `18` / `1800` | start only when the 1-minute load is below `LOAD_MAX`; give up after `LOAD_WAIT_MAX` s |
| `STOP_GRACE` | `10` | seconds `compose stop` waits before killing node X |
| `STALL_LIMIT` | `90` | longest allowed gap, in seconds, between increases of the lowest head among the watched nodes, or of the highest, and longest allowed time without a head read in which all of them answered |
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
write probe of the node state), starts the 4 postgres, applies the migrations,
starts the 4 nodes one at a time, and waits (cap `SMOKE_TIMEOUT`, 5 minutes)
until every node answers RPC with a head of at least `SMOKE_HEAD`. It then
prints `SMOKE PASS` or `SMOKE FAIL`, tears the project down and exits: 0 pass,
1 a node did not make it (each node gets a row; a failing one names its log,
`logs/node-N.log` in the run dir, written at teardown, and the last 15 lines are
printed), 2 the preflight or a postgres failed, 3 pass but the teardown failed
(see Output). No backup, wipe or restore
runs, and there is no isolated node. Genesis is set `GENESIS_DELAY` (160 s by
default) after the inputs are made and the cap counts from the first node
start; if a host needs more than 5 minutes, raise `SMOKE_TIMEOUT`.

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
`output/` is written only by the backup utility. The reasoning is in
`gen-compose.py` above `START_SCRIPT`.

1. Preflight: tools, load wait, disk, RAM, no swapping, project name unused,
   ports free, images local, uid-1000 readability of the inputs, gossip on
   (and `node` in the image), the uid-1000 write probe of the node state.
   "Project name unused" means no container or volume carries the project's
   compose label and, before the first `compose up`, no volume exists with
   any of the exact names the generated compose file declares
   (`<project>_state-4`, `<project>_pgdata-1`, ...), whatever its labels.
   Compose would use such a volume and teardown's `down -v` would delete it,
   so the run names the ones it found and exits 2 without creating any
   container or volume. A `docker ps` or `docker volume ls` listing of the
   project that fails (exit status not 0) shows nothing about what exists: the
   run names the command and exits 2 the same way. The count of migration
   files in the image's `src/migrations`, which the schema check compares with
   after the wipe, has to succeed and be at least 1; else the run prints its
   exit status and output and exits 2 the same way.
2. Bring-up: postgres x4, migrations on each database (manual step, see
   below), nodes one at a time, wait until every node is at height `H0`.
   Record node X's head height and block hash, and the SHA-256 of its identity
   file and signing state files (`node.identity`, `.signed.json`,
   `.commitlock.json`, `.prevote.json`; the `.lock` beat file is left out).
   Only hashes and heights are printed; no file content is.
3. **A** backup: stats, `pg_dump -Fc` inside node X's postgres container into
   a staging volume, stats again, `test -s`, `pg_restore --file=/dev/null`
   (reads the whole archive, as `database-migrations.md` step 1 requires;
   `--list` reads only the table of contents) and `sha256sum` on the dump. If
   the dump is empty or cannot be read to its end, the run exits 2 before the
   wipe. The stats run with `ON_ERROR_STOP=1`; if either snapshot's query
   fails, or lacks a numeric `max_block`, `blocks`, `transactions`,
   `fork_state` or `migrations` row (what the restore is checked against), the
   run names them and exits 2 before the wipe. The database only: the
   identity and signing state files are not copied, they stay on node X's
   state volume, which the wipe keeps. Backing
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
   again. So it does if the identity and signing state files, hashed again
   after the wipe, are not the same names with the same SHA-256 as at stop.
   The wipe uses no `--reset`, no reset-node script and no `down -v`;
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
   2 blocks of the other three and it is on their chain: at the highest height
   all four have, above the pre-wipe head, all four give one block hash (a node
   that matches the others up to its stop and forks after it never gets there).
   Each try reads all four heads again, one read each, and judges the gap and
   the height from those reads only: a head one of them does not answer fails
   that try, it is never left out.
   D adds proof that it signs: its signing record
   height moves past the value at stop, or a block after the restart carries
   its signature. Row **ALL** is stop of node X to rejoined and signing (the
   outage as an operator sees it); like D1 and D, it is written only when node
   X got there.
8. Checks (below), the timings table, teardown.

`VARIANT=isolated` runs 1 to 4, leaves node X running, restores the dump into
a new postgres, applies migrations, compares counts with the dump, and (with
`ISO_NODE=1`) starts a node with no identity mounted, outside the validator
set, on the restored database. Node X's key is never mounted anywhere else.

## Checks

Each is printed PASS, FAIL or INFO, and written to `timings.md` and
`timings.json`. A check passes only on evidence the run has read: a read that
fails, or that gives nothing (no head, no hash, no checksum, an empty log or
listing), fails the check that needs it, with the reason; it is never skipped or
turned into INFO. Before the wipe and the restart, such a read stops the run
(exit 2) instead. Two rows are INFO by design, never PASS or FAIL, and claim
nothing: "uid 1000 write probe of the node state" and, in `isolated`, "whether
node X stopped or restarted during the isolated drill".

| Check | Passes when |
|---|---|
| node X rejoins (head within 2 blocks, on the others' chain) | written only as a FAIL, when D1 is not reached in `REJOIN_TIMEOUT` (see D1 above) |
| restored head >= pre-wipe head | head after the rejoin >= head read from the database at stop |
| node X within 2 blocks of the others at the end of D, on their chain | read again once D is over (only if D1 was reached), one head read of each of the four, judged on those reads only: node X's head is still within 2 blocks of the highest other node's, not only once during D, and node X and every other node give one non-empty block hash at the highest height all of them have, which must be above the pre-wipe head; no such height, or a head or hash that cannot be read, fails it |
| block hash at pre-wipe heights | each node's hash, node X's too, at the step-2 height and the at-stop height equals the one recorded then (node X's at step 2, its database's at stop) |
| identity file checksum | identical at step 2, at stop, and after the rejoin; the files after the rejoin must all have been hashed |
| signing state | every signing file present at stop, and every `.signed.json`, `.commitlock.json` and `.prevote.json` present at step 2, still exists after the rejoin (one there at step 2 and not at stop fails it), and those three are never older than at stop, by height, then round (`timestamp` in `.signed.json`, `round` in the other two). At least one of the three must be compared, and a file that cannot be hashed after the rejoin fails it (at stop or after the wipe it stops the run). The detail gives each one's height/round at stop and after: `advanced` only when strictly newer, `unchanged` when equal; an older one, or one without a height and round, fails the check |
| no halt marker | the state volume's listing is read and holds `node.identity`, with no `*.halted`; node X's log is read once and is not empty, with no foreign-signature line. A log `docker logs` cannot give (a logging driver without reads), or an empty one, fails it |
| signing floor | the `Restart signing floor` line is in node X's log, read to its end; INFO if a log that was read lacks the line, FAIL if the log cannot be read or is empty |
| node X signs | see D above |
| other nodes never stalled | every 5 s the run reads the head of each watched node (the other nodes in `rejoin`, all four validators in `isolated`) and keeps the lowest and the highest; a head read in which one of them does not answer counts as failed. So the slowest validator decides, one node rising alone does not pass, and nor does a slow one catching up while the others make no new block. With the devnet's quorum (below), the longest gap between increases of the lowest head, or of the highest, while node X was down, counted up to the read that sees the rise and to the end of the outage, is at most `STALL_LIMIT`, and at most half the head reads failed. It also needs at least one new block on every watched validator: the lowest head at the window's last successful read must be above the highest at its first, however short the window; a window without one fails with "no new block on the watched validators between `<t0>` and `<t1>`" (unix times, as in `logs/monitor.tsv`). No successful head read for longer than `STALL_LIMIT` fails it, saying a stall in that time cannot be ruled out. The `isolated` variant's "validators kept forging" check applies the same rule to the whole drill |
| restored counts match the dump | max block, blocks and transactions inside the before/after window of the dump; `fork_state` and `migrations` rows in the dump's counts and equal; same table set. Written after the restore's migration, before node X starts again |
| schema at the image's head | rows in `migrations` equal the migration files in the image's `src/migrations`, of which there must be at least one counted (preflight stops with exit 2 otherwise) |
| one instance of the key | asserted before the single start (a `docker ps` listing that fails stops the run); written after it |
| isolated node reaches the expected head, on the validators' chain | (`isolated`, `ISO_NODE=1`) within `REJOIN_TIMEOUT`, in one try that reads the heads of node-iso and of every validator once each, every one of them answers, node-iso's head is within 2 blocks of the highest validator's, and node-iso and every validator give one non-empty block hash at the highest height all of them have, which must be above the database's head |
| isolated node holds no copy of node X's key | (`isolated`) node-iso's mounts are read and include its own state volume and no identity or state volume of node X, and the identity file on node-iso's state volume, read as a SHA-256 (64 hex), differs from node X's step-2 one; an identity that cannot be read, or a read that gives no SHA-256, fails it |
| node X's key is held by only the one container on its state volume | (`isolated`) the running node X containers and the running containers on its state volume are both listed (a listing that fails fails it), and each list is exactly the container started at bring-up |
| whether node X stopped or restarted during the isolated drill | INFO only: the node X container running at the end and the one started at bring-up. A restart in place (`restart: unless-stopped`) keeps the container id, so the drill does not show that node X never stopped |
| gossip enabled on every node | `GOSSIP_ENABLED=true` in the generated compose file (INFO when `ALLOW_GOSSIP_OFF=1` lets it be off) |
| uid 1000 write probe of the node state | INFO only, not a check: what the probes of "Writable state" above covered (a probe that fails stops the run before it starts) |
| the wipe kept the ownership of the state volume | owner and mode of the state dir and identity files equal before and after the wipe (a read of them that fails stops the run with exit 2: at stop before anything is removed, after the wipe before the restore) |

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
`node-4.pre-wipe.log`), `logs/monitor.tsv` (every 5 s, the lowest and the
highest head of the watched nodes; empty when one of them did not answer),
`backup/` (dump, SHA-256, before/after counts), `phases.tsv`, `checks.tsv`.
On exit, including on Ctrl-C or an error, teardown tries to remove the
`demos-bkdrill` compose project: it removes the helper containers that carry
the label `demos.drill.helper=<project>` and runs `compose down -v` for that
project only. When it works, this removes the drill's own volumes, node X's
state volume with its throwaway key included. Preflight refuses to start when
a volume with one of the declared names already exists, or when the listing of
the project's containers or volumes fails (step 1), so the named
volumes `down -v` deletes are ones this run created.

Teardown then lists the containers, volumes and networks that still carry the
label `com.docker.compose.project=<project>` and prints the counts. If
`down -v` exits non-zero, a listing fails, or anything is left, it prints
`CLEANUP FAILED` with the reason, writes the same as `cleanup` in
`timings.json` and as `cleanup: **FAILED**` in `timings.md` (`result` keeps
the drill's own verdict), and exits 3 instead of 0. Then check, with Docker
working again (`<project>` is the `PROJECT` the run used, `demos-bkdrill` by
default):

```bash
docker ps -a --filter label=com.docker.compose.project=<project>
docker volume ls --filter label=com.docker.compose.project=<project>
docker network ls --filter label=com.docker.compose.project=<project>
```

and read `logs/teardown.log`. Teardown's own command can be run again by hand,
with `<OUT_DIR>` the run's directory:
`docker compose -f <OUT_DIR>/compose.yml -p <project> down -v --remove-orphans`.
Run it only on a drill project: `down -v` deletes the project's volumes, so
never on a validator's project (see "Drill volumes only" in step 5 above).
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
declares (exit 2, no `up`, no `down`, the volume untouched), a `docker ps` or
`docker volume ls` listing of the project that fails in preflight (exit 2
naming the command, no `up`, no `down`, the project's container or volume
left in place), an owner read of node X's state dir that fails at stop or
after the wipe (exit 2, before the wipe or before the restore), a dump that
cannot be read to its end (exit 2 in phase A, nothing wiped), an SQL error in
the stats of either backup snapshot (exit 2 in phase A naming the missing rows,
nothing wiped; in a restored database the restore's checks fail instead), a
migration file count that fails or is 0 (exit 2 in preflight, nothing
created), a wipe that fails,
leaves an entry or removes a signing state file (exit 2, node X not started
again), a commit lock or prevote record older than at stop (the signing state
check fails), head reads that fail for longer than `STALL_LIMIT`, and watched
nodes that stay at one head, or one that does not answer, while another keeps
rising, for longer than `STALL_LIMIT`, every watched node at one head for a
whole window shorter than `STALL_LIMIT`, and a lagging watched node catching up
while the others make no new block (the stall checks of both variants fail;
with the same settings and no fault they pass), more than half the head reads
failed, a node X that never comes within 2 blocks, falls behind again after
signing, or never signs (no D or ALL row), a node X at the head of one other node
while the two others do not answer one read and answer the next 900 blocks
above it (the rejoin check fails, no D1 row), a changed identity file, a restored
row count outside the dump's window, another node's block hash, migrations short
of the image's, a halt marker, a foreign-signature line or a log `docker logs`
cannot read, a second container on node X's state volume (the run stops before
node X starts again; in `isolated` the holder check fails), a dump copy that
fails its hash (exit 2 in phase A2), and in `isolated` a restored database
without the dump's head, another hash at its head, a node-iso that stays behind,
and a node-iso identity that is node X's, cannot be read, or is read as nothing
with exit 0 (each fails its own check, and only it), a node X or a node-iso that
matches the validators up to its stop (its restored database's head) and forks
after it (the rejoin or catch-up check fails), a signing file gone from the state
volume before the stop (the signing state check fails), every read giving nothing
with exit 0 once the restarted node X or node-iso serves (every check written from
then on fails, exit 1), the default `OUT_DIR` of a run started in the same second
as another of the project, a second run of a project whose
lock is held and an `OUT_DIR` that already exists, empty or not (exit 2, nothing
written), the project in the default `OUT_DIR` name, a teardown whose `down`
fails or leaves a volume (exit 3 after a pass, the failure in `timings.json`
and `timings.md`; the full drill too), and a full `rejoin` and `isolated` run. It needs no Docker and tests
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
is a warning (only a `run-devnet` image migrates at start; a release node
does not, and refuses pending migrations, so it fails the serve wait); on the
restored database it is fatal unless `MIGRATE_REQUIRED=0`. Each run is stopped
after `MIGRATE_TIMEOUT` seconds (300 by default; `timeout -k 10`: TERM, then
KILL 10 s later), logged as `migrations on <database> timed out`, and counts
as a failed migration.

On each run on a new image, the result must show the migrate step passing: no
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
  left behind. The drill pins each node's hostname (`gen-compose.py`), so its
  own stale lock is replaced at once (`src/libs/identity/identityLock.ts`, a
  lock from the same hostname with no heartbeat for 20 s); a production
  container recreated with a new hostname watches it 10 to 25 s first
  (`validator-key.md`), which these timings do not include.
- The restore is a head start. The node still has to sync the blocks produced
  while it was down; D1 is that time.
- A dump, however fresh, may be older than the head the node had: compare
  `head_at_stop` with `dump_head_window` in `timings.md`.
