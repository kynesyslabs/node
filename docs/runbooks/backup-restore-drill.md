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
state untouched, and how many seconds each step takes. It does not show that
the production `docker-compose.yml` volumes behave the same (this drill has
its own compose file), and it does not cover losing the identity volume: that
case has no restore path by design (`validator-key.md`).

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
- Outbound UDP 123 from containers: the node refuses to start without two NTP
  readings (`validator-key.md`). If the first node does not serve, look here
  first.
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

## Invocation

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
carried out (preflight, boot, timeout, a step that must work failed).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `NODE_IMAGE` | `demos-node:candidate-5979a716` | prebuilt node image |
| `PG_IMAGE` | `postgres:16-alpine` | postgres and helper image |
| `BASE_PORT` | `65000` | host ports `BASE_PORT+1..+5`, 127.0.0.1 |
| `PROJECT` | `demos-bkdrill` | compose project; must start with `demos-`; the run aborts if anything of that name exists |
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
| `ISO_NODE` | `1` | in `isolated`, also start a non-signing node on the restored database |
| `KEEP_KEYS` | `0` | `1` keeps the identity inputs and the state copy after the run |
| `IDENTITY_GEN` | `auto` | `host` (bun on the host), `image` (inside `NODE_IMAGE`), or `auto` |

## What it does

Devnet: 4 validators, each with its own postgres (data in a named volume) and
its own state volume at `/app/state` holding the identity and signing state.
Genesis, peerlist and fork schedule come from `quorum-drills/gen-inputs.py`
unchanged; only the compose file is different (persistent volumes instead of
tmpfs, one postgres per node, an isolated node, a one-off `migrate` service).

1. Preflight: tools, load wait, disk, RAM, no swapping, project name unused,
   ports free, images local, uid-1000 readability of the inputs.
2. Bring-up: postgres x4, migrations on each database (manual step, see
   below), nodes one at a time, wait until every node is at height `H0`.
   Record node X's head height and block hash, and the SHA-256 of its identity
   file and signing state files (`node.identity`, `.signed.json`,
   `.commitlock.json`, `.prevote.json`; the `.lock` beat file is left out).
   Only hashes and heights are printed; no file content is.
3. **A** backup: stats, `pg_dump -Fc` inside node X's postgres container into
   a staging volume, stats again, `pg_restore --list` and `sha256sum` on the
   dump, and a copy of the identity and signing state files into the same
   volume. The state copy is taken live: it is a safety net only and is never
   restored from.
4. **A2** copy the staging volume to `$OUT_DIR/backup/` on the host
   (`docker cp`), check the SHA-256 there.
5. **B** wipe (`rejoin`): stop node X, read its true head from its database,
   hash the signing state at rest, remove the node container, the postgres
   container, the database volume and the staging volume, and delete
   everything on the state volume except `node.identity*`. No `--reset`, no
   reset-node script, no `down -v`.
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
The `demos-bkdrill` compose project is removed on exit, including on Ctrl-C or
an error (`compose down -v` for that project only, plus helper containers that
carry the label `demos.drill.helper=<project>`).

## Manual migrations

The drill applies migrations itself, as the G16-a change needs
(`migrationsRun: false`, `docs/runbooks/database-migrations.md`): on every
database before the nodes start, and on the restored database before node X
starts. It runs `MIGRATE_CMD` in a one-off container of `NODE_IMAGE`, with
`PG_HOST` and `PG_DATABASE` pointed at that database. The default,
`bun run migration:run`, is the repo script (`package.json`); set `MIGRATE_CMD`
to whatever the migrations runbook settles on. At bring-up a failing migration
is a warning (a node that still migrates at boot does not need it); on the
restored database it is fatal unless `MIGRATE_REQUIRED=0`.

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
