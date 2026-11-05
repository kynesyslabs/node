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
undone. Every file under `src/migrations/` has a `down()`, but do not trust it.
Before you run a release's migrations, read the `down()` of each file that
`migration:show` lists as pending, and assume it cannot be undone. Examples of
what a `down()` can do (the list is not complete, and new files keep landing):

- `BaselineSchema` drops every table.
- Migrations that create a table (for example `CreateL2PSMessagesTable`,
  `CreateAtomicWorkTables`, `CreateAcceptedForkSchedule`) drop the table and its rows.
- Migrations that add a column (for example `AddAttrsToTransactions`) drop the column.
- `EncryptL2PSTransactionHistory` drops `encrypted_payload` and overwrites empty
  `content` with `{}`.
- The `Widen...ToNumeric` migrations narrow `numeric` back to `bigint` and error
  on large values.
- `CanonicalizeL2PSMessageKeys` has a no-op `down()`: its `up()` is irreversible.
- `ScopeL2PSMessageHashUnique` re-adds a unique constraint and fails on duplicates.

So the backup in step 1 is the only way back. Do not rely on
`migration:revert`.

A release can need its migration before a feature works. For example, the
storage-proof calls added in #1111 read the `storage_program_history` table
created by its migrations, so run `migration:run` before using them.

## Commands

All from the node checkout (or inside the node container), pointed at the
database by the same `PG_*` settings the node uses.

| Command | Does |
|---|---|
| `bun run migration:show` | lists migrations; `[X]` applied, `[ ]` pending |
| `bun run migration:run` | applies all pending migrations, in one transaction |
| `bun run migration:revert` | undoes the last one. Lossy, see above |

In the Docker stack, run them in a one-off container (the node can be stopped,
Postgres must be up: `--no-deps` does not start it). `--name demos-migrate` gives
the one-off container its own name, so it can never clash with the node service's
`container_name` while the stopped node container still exists. (Checked on
Compose 2.40.3: `run` without `--name` did not clash there either; the flag is kept
for Compose versions that behave differently.)

```bash
docker compose run --rm --no-deps --name demos-migrate node bun run migration:show
```

## Procedure

Do it on **one** validator first, then the rest. Never on all at once.

1. **Back up.** Stop the node but keep Postgres up, then dump the database.
   Postgres has to be running for the dump, and for steps 2 and 3:

   - **Docker:** stop only the node and its reaper, so Postgres stays up:
     `docker compose stop reaper node`. Stopping the node alone is not enough:
     the `reaper` service then stops the whole stack, Postgres included. Bring
     the stack back with `docker compose up -d` (or `./run --docker`).
   - **Bare metal:** the launcher runs `docker compose down` on its Postgres
     (`postgres_<PG_PORT>`) when the node stops, so the container is gone and the
     dump fails (no such container, or connection refused). Start that Postgres
     alone first, and wait until it is ready (the `postgres_<PG_PORT>` folder
     exists only after the first `./run`; on a new host make the first start
     `./run -c true` instead, which creates the schema itself):

     ```bash
     (cd postgres_<PG_PORT> && PG_PORT=<PG_PORT> docker compose up -d)
     docker exec postgres_<PG_PORT> pg_isready -h 127.0.0.1 -U demosuser -d demos
     ```

     Repeat the `pg_isready` line until it prints `accepting connections`. The
     next `./run` stops and restarts this container; the data stays in
     `postgres_<PG_PORT>/data_<PG_PORT>`.

   The dump holds the
   whole chain database, so write it into a private directory and make the
   file private from the start (`umask 077` before the redirect creates it
   mode 600, not 644):

   ```bash
   mkdir -p ~/demos-backups && chmod 700 ~/demos-backups
   umask 077
   docker compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > ~/demos-backups/demos-$(date +%Y%m%d-%H%M).dump
   ```

   That form is for the `postgres` service of the Docker stack
   (`docker-compose.yml` in the checkout root). The single quotes matter: the
   user and database names are read by the shell **inside** the container, from
   the `POSTGRES_USER` / `POSTGRES_DB` it was started with. That is right even
   when `PG_USER` / `PG_DATABASE` are set only in Compose's `.env` and not
   exported in your shell. `-T` is required: without it Compose allocates a
   terminal, which corrupts the redirected binary dump. For the Postgres the
   launcher starts by itself (container `postgres_<PG_PORT>`, 5332 by default),
   use
   `docker exec postgres_<PG_PORT> sh -c 'exec pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > <file>`
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
      `docker compose exec -T postgres sh -c 'exec pg_restore --file=/dev/null' < <file>`
      (or `docker exec -i postgres_<PG_PORT> sh -c 'exec pg_restore --file=/dev/null' < <file>`;
      `-i` passes the file in, still no `-t`).

   3. **Where you can, restore it into a scratch database** and look at it. This
      is the only check that proves the dump can be restored:

      ```bash
      createdb -h <PG_HOST> -p <PG_PORT> -U <PG_USER> demos_restore_check
      pg_restore --exit-on-error --no-owner -h <PG_HOST> -p <PG_PORT> -U <PG_USER> -d demos_restore_check ~/demos-backups/<file>.dump
      dropdb -h <PG_HOST> -p <PG_PORT> -U <PG_USER> demos_restore_check
      ```

      Use a scratch name, never the live database name. On the Docker stack,
      run the three commands inside the container, with the user name read
      there (`docker exec -i postgres_<PG_PORT>` instead of
      `docker compose exec -T postgres` for the launcher's Postgres). The
      container's own socket is used, so no `-h` / `-p`:

      ```bash
      docker compose exec -T postgres sh -c 'exec createdb -U "$POSTGRES_USER" demos_restore_check'
      docker compose exec -T postgres sh -c 'exec pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d demos_restore_check' < ~/demos-backups/<file>.dump
      docker compose exec -T postgres sh -c 'exec dropdb -U "$POSTGRES_USER" demos_restore_check'
      ```

      Skip this only if there is no room or no second database to restore
      into, and say so in your change record.

   If any check fails, take the dump again and do not go on to step 2.

2. **Apply on one validator.** With the new release deployed, the node stopped
   and Postgres still up (step 1):

   ```bash
   bun run migration:show    # the new migration(s) are listed as [ ]
   bun run migration:run
   ```

   On the Docker stack, run each as
   `docker compose run --rm --no-deps --name demos-migrate node bun run migration:show` (see
   Commands). On bare metal, run each as
   `PG_HOST=localhost PG_PORT=<PG_PORT> bun run migration:show`: the launcher
   passes its port only to the node it starts, and `.env` may name another.

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

The node does not apply migrations when it starts, but it checks for them:
right after it connects to the database, before it loads its identity or
touches the chain, it asks TypeORM whether any migration in `src/migrations/`
is not yet recorded in the database. If one is, it logs
`[BOOT] The database has migrations that are not applied ...` with the
commands below and exits with code 1, without writing a block. That happens on
a new, empty database (no `migration:run` before the first start) and after
deploying a release that adds a migration without step 2 (for example
`./run -U`, which pulls a release and boots it at once). The check itself
creates the empty `migrations` bookkeeping table on a database that has none,
as `migration:show` does; it changes nothing else.

If you see that line, keep the node stopped (Postgres stays up, see step 1)
and run `bun run migration:show`. Any `[ ]` line is pending: do the procedure
above (backup first) and start the node again. On a new, empty database there
is nothing to back up: run `bun run migration:run` once. Before `./run -U` or
any update, run `bun run migration:show` after the pull and apply what is
pending.

## External database

An external database (`EXTERNAL_DB` true: `./run -e` or `./run --external-db`)
is **never** migrated by any launcher, including with `-c true`. The launchers
only create the schema on the Postgres they start themselves. On an external database, run
`bun run migration:run` yourself, for a first install and for every release
that adds a migration.

## Test harnesses

`testing/devnet/run-devnet` (used by the devnet, `consensus-race` and
`quorum-drills` on a devnet-style image) and `testing/l2ps-messaging/e2e.sh`
run `migration:run` before they start the node, because their databases are
created empty. On a release image `quorum-drills` has no `run-devnet`: the
nodes run the image's own entrypoint, so `quorum-drills/run.sh` must migrate
each node database itself, in a one-off container of the image, before any
node starts. The
devnet image is `oven/bun` with no Node, so `run-devnet` runs the TypeORM CLI
through bun directly (`bun -r tsconfig-paths/register
./node_modules/typeorm/cli.js migration:run -d ./src/model/datasource.ts`)
instead of `bun run migration:run`, which needs `tsx` and so a `node` binary.
`run-devnet` does this on every start, not only the first (idempotent).
`testing/genesis-acceptance/run.sh` starts the published image on empty
databases (`CREATE DATABASE`); after each one it runs `bun run migration:run`
once in a one-off container of the image under test, the operator's first-start
step. Its `TEMPLATE chain_base` copies already have the schema. Also,
`consensus-race` runs a prebuilt `RACE_IMAGE`: only an image built from this
commit has the migrate step.

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
