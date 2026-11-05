---
type: runbook
title: Apply Database Migrations by Hand
date: 2026-11-04
status: active
---

# Apply Database Migrations by Hand

The node does **not** run TypeORM migrations when it starts
(`migrationsRun: false` in `src/model/datasource.ts`). A release that adds a
file under `src/migrations/` changes nothing in the database until an operator
applies it. `synchronize` is `false` as well, so entity changes never alter the
schema on their own.

Why: all pending migrations run in one transaction, and a bad one cannot be
undone. There are 16 migration files, each with a `down()`. 8 of the `down()`
methods drop data:

| Migration | `down()` |
|---|---|
| `BaselineSchema` | drops every table |
| `CreateL2PSMessagesTable`, `CreateAtomicWorkTables`, `CreateL2PSExecutedHashes`, `CreateAcceptedForkSchedule` | drops the table and its rows |
| `AddAttrsToTransactions`, `AddAttrsToBlocks` | drops the `attrs` column |
| `EncryptL2PSTransactionHistory` | drops `encrypted_payload`, overwrites empty `content` with `{}` |

The other 8 do not drop data, but four of them cannot be reverted cleanly:

| Migration | `down()` |
|---|---|
| `WidenTransactionsMoneyColsToNumeric`, `WidenL2PSTransactionsAmountToNumeric` | narrows `numeric` back to `bigint`; errors on large values |
| `CanonicalizeL2PSMessageKeys` | no-op: its `up()` is irreversible, the original keys are gone |
| `ScopeL2PSMessageHashUnique` | re-adds a unique constraint; fails on duplicates |
| `UniqueBlockNumber`, `IndexL2PSHistoryReads`, `IndexL2PSEncryptedHash`, `IndexL2PSMessageTxHash` | index-only |

So the backup in step 1 is the only way back. Do not rely on
`migration:revert`.

## Commands

All from the node checkout (or inside the node container), pointed at the
database by the same `PG_*` settings the node uses.

| Command | Does |
|---|---|
| `bun run migration:show` | lists migrations; `[X]` applied, `[ ]` pending |
| `bun run migration:run` | applies all pending migrations, in one transaction |
| `bun run migration:revert` | undoes the last one. Lossy, see above |

In the Docker stack, run them in a one-off container (the node can be stopped):

```bash
docker compose run --rm --no-deps node bun run migration:show
```

## Procedure

Do it on **one** validator first, then the rest. Never on all at once.

1. **Back up.** Stop the node, then dump the database. The dump holds the
   whole chain database, so write it into a private directory and make the
   file private from the start (`umask 077` before the redirect creates it
   mode 600, not 644):

   ```bash
   mkdir -p ~/demos-backups && chmod 700 ~/demos-backups
   umask 077
   docker compose exec -T postgres pg_dump -U "${PG_USER:-demosuser}" -Fc "${PG_DATABASE:-demos}" > ~/demos-backups/demos-$(date +%Y%m%d-%H%M).dump
   ```

   That form is for the `postgres` service of the Docker stack
   (`docker-compose.yml` in the checkout root). `-T` is required: without it
   Compose allocates a terminal, which corrupts the redirected binary dump. For
   the Postgres the launcher starts by itself (container
   `postgres_<PG_PORT>`, 5332 by default), use
   `docker exec postgres_<PG_PORT> pg_dump -U demosuser -Fc demos > <file>`
   (no `-t` either, for the same reason).
   For a bare-metal or external database, dump from the host with the `PG_HOST`,
   `PG_PORT`, `PG_USER` and `PG_DATABASE` of the node config. Keep the password
   off the command line: put it in `~/.pgpass` (mode 600) or point `PGPASSFILE`
   at a file:

   ```bash
   umask 077
   pg_dump -h <PG_HOST> -p <PG_PORT> -U <PG_USER> -Fc <PG_DATABASE> > ~/demos-backups/demos-$(date +%Y%m%d-%H%M).dump
   ```

   `umask` applies to the current shell only: run it in the same shell as the
   dump. Keep a copy off the host.

   **Check the dump before you migrate.** A failed `pg_dump` still leaves the
   redirect target behind, possibly empty or cut short. Do all three checks:

   1. **The dump's exit status.** Read it on the line right after the dump
      command, before you run anything else (`$?` is overwritten by the next
      command):

      ```bash
      echo "pg_dump exit status: $?"
      ```

      With the `docker compose exec` / `docker exec` / host `pg_dump` forms
      above, this is the status of `pg_dump` itself. If you pipe the dump into
      anything (`gzip`, `tee`), run `set -o pipefail` first, or the status is
      the last command's. If it is not `0`: delete the file
      (`rm ~/demos-backups/<file>.dump`) and stop. Do not go on to step 2.

   2. **Read the whole archive.** `pg_restore --list` reads only the table of
      contents at the start of the file, so a dump cut off after it but before
      all the data still passes. Read every data item instead; the output is
      thrown away, only the exit status matters:

      ```bash
      test -s ~/demos-backups/<file>.dump && pg_restore --file=/dev/null ~/demos-backups/<file>.dump && echo dump read OK
      ```

      `test -s` fails on a zero-byte file; `pg_restore --file=/dev/null` fails
      on a file that is not a complete custom-format archive. With no
      `pg_restore` on the host, run it in the container, same form as the dump:
      `docker compose exec -T postgres pg_restore --file=/dev/null < <file>`
      (or `docker exec -i postgres_<PG_PORT> pg_restore --file=/dev/null < <file>`;
      `-i` passes the file in, still no `-t`).

   3. **Where you can, restore it into a scratch database** and look at it. This
      is the only check that proves the dump can be restored:

      ```bash
      createdb -h <PG_HOST> -p <PG_PORT> -U <PG_USER> demos_restore_check
      pg_restore --exit-on-error --no-owner -h <PG_HOST> -p <PG_PORT> -U <PG_USER> -d demos_restore_check ~/demos-backups/<file>.dump
      dropdb -h <PG_HOST> -p <PG_PORT> -U <PG_USER> demos_restore_check
      ```

      Use a scratch name, never the live database name. On the Docker stack,
      run the same three commands through `docker compose exec -T postgres`
      (feed the dump to `pg_restore` with `< <file>`). Skip this only if there
      is no room or no second database to restore into, and say so in your
      change record.

   If any check fails, take the dump again and do not go on to step 2.

2. **Apply on one validator.** With the new release deployed and the node
   stopped:

   ```bash
   bun run migration:show    # the new migration(s) are listed as [ ]
   bun run migration:run
   ```

   If it fails, the transaction rolls back and nothing changed. Do not start
   the node on the new release; fix the cause or restore the dump.

3. **Check it.**
   - `bun run migration:show` lists every migration as `[X]`.
   - In Postgres: `SELECT name FROM migrations ORDER BY id DESC LIMIT 3;`
     (TypeORM's default table name) shows the new migration.
   - Start the node. `curl -fsS http://localhost:53550/health | jq .status`
     is `ok` (see `health-endpoint.md`).
   - Blocks are produced: run `SELECT max(number) FROM blocks;` twice, a
     minute apart, and compare with the other validators. The value rises,
     and no `HeightStalled` alert fires (see `mainnet-monitoring.md`).

   Leave it running before continuing. Do not go on if any check fails.

4. **Apply to the rest**, one validator at a time, repeating steps 1 to 3 on
   each. Keep enough validators online to hold consensus.

## Pending migrations at start

The node does not check for pending migrations when it starts. If you deploy a
release that adds a migration (for example `./run -U`, which pulls a release and
boots it at once) and do not run step 2 first, the node boots onto the old
schema and fails with a database error: `relation "..." does not exist` or
`column "..." does not exist`. The first one usually shows at genesis
(missing `accepted_fork_schedule`), but other missing columns can fail later,
while the node is already in consensus.

If you see that, stop the node and run `bun run migration:show`. Any `[ ]` line
is pending: do the procedure above (backup first) and start the node again.
Before `./run -U` or any update, run `bun run migration:show` after the pull and
apply what is pending.

## External database

An external database (`EXTERNAL_DB` true: `./run -e` or `./run --external-db`)
is **never** migrated by any launcher, including with `-c true`. The launchers
only create the schema on the Postgres they start themselves. On an external database, run
`bun run migration:run` yourself, for a first install and for every release
that adds a migration.

## Test harnesses

`testing/devnet/run-devnet` (used by the devnet, `consensus-race` and
`quorum-drills`) and `testing/l2ps-messaging/e2e.sh` run `migration:run`
before they start the node, because their databases are created empty. The
devnet image is `oven/bun` with no Node, so `run-devnet` runs the TypeORM CLI
through bun directly (`bun -r tsconfig-paths/register
./node_modules/typeorm/cli.js migration:run -d ./src/model/datasource.ts`)
instead of `bun run migration:run`, which needs `tsx` and so a `node` binary.
`run-devnet` does this on every start, not only the first (idempotent). Known
gap: `testing/genesis-acceptance/run.sh` starts the published image on empty
databases (`CREATE DATABASE`) and does not migrate them. Run `bun run
migration:run` against each of them first, or the node stops with a missing
table error before the scenario's own refusal. Also, `consensus-race` runs a
prebuilt `RACE_IMAGE`: only an image built from this commit has the migrate
step.

## Roll back

Restore the step 1 dump into an empty database (`pg_restore -d <db> --clean
--if-exists <file>`) and deploy the previous release. Blocks made after the
dump must be re-synced from peers.

## Fresh database

A database with no tables has no schema until `bun run migration:run` runs
once (the baseline migration creates it). Nothing to lose there, so no backup is
needed. The launchers do it for you only after they empty the database, once
per wipe, before the node starts:

- `./run --docker --clean` and `./run --docker --devnet --clean`
- `./scripts/wipe-and-reboot.sh`
- bare-metal `./run -c true` (clean start)
- bare-metal `./run -b true` (restore): it exports the balances from the old
  database, wipes Postgres, then creates the schema on the empty one

They fail closed. If stopping the stack or removing the volume or data directory
fails, they stop with an error before anything is migrated. Right before
`migration:run` they also check that the database has no tables in the public
schema, and refuse with a message otherwise (a wipe that did not take effect
would otherwise migrate live data with no backup). If you see that refusal, the
database was not wiped: back it up and migrate by hand (procedure above).

A plain start of the node never migrates. The one exception is the devnet
harness (`testing/devnet/run-devnet`): it runs `migration:run` on every start,
not only after a wipe. That is safe, because `migration:run` applies only what
is pending and does nothing on an up-to-date database. Anything else that empties the database
(`scripts/start_db -c`, `postgres/clean.sh`, deleting `data_*` or the Docker
volume by hand) does not either: run `bun run migration:run` yourself before
the node starts, as you do for a first install on a new host.
