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

1. **Back up.** Stop the node, then dump the database:

   ```bash
   docker compose exec postgres pg_dump -U "${PG_USER:-demosuser}" -Fc "${PG_DATABASE:-demos}" > demos-$(date +%Y%m%d-%H%M).dump
   ```

   Keep the file off the host. Check it is not empty (`pg_restore -l <file>`).

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

## Roll back

Restore the step 1 dump into an empty database (`pg_restore -d <db> --clean
--if-exists <file>`) and deploy the previous release. Blocks made after the
dump must be re-synced from peers.

## Fresh database

A database with no tables has no schema until `bun run migration:run` runs
once (the baseline migration creates it). Nothing to lose there, so no backup is
needed. The launchers do it for you only after they empty the database:
`./run --docker --clean`, `./run --docker --devnet --clean`,
`./scripts/wipe-and-reboot.sh` and the bare-metal `./run --clean`. For a first
install on a new host, run `bun run migration:run` yourself before the first
start.
