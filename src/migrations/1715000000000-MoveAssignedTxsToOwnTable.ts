import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Moves the per-account "list of transactions seen" mapping out of
 * `gcr_main."assignedTxs"` (a growing jsonb array per account) into its
 * own append-only relation `gcr_assigned_txs`.
 *
 * Why: each block applied to gcr_main rewrote that jsonb column, and TOAST
 * chunks are immutable — every UPDATE wrote new chunks and dead-tupled the
 * old ones. The append-only shape meant cumulative writes scaled as O(N²)
 * in lifetime tx count per account. A normal relation makes each assignment
 * a single INSERT with no read-modify-write.
 *
 * Backfill source: the `transactions` table, not the old `assignedTxs`
 * column. Rationale:
 *   - `transactions` is the authoritative record of every tx ever applied,
 *     so it reproduces the same set the runtime would have built up over
 *     time (the runtime appended sender→hash for every successful tx).
 *   - It carries `blockNumber` directly, so the new table gets real block
 *     numbers instead of 0 placeholders.
 *   - It works on nodes where the prior `assignedTxs` column was already
 *     dropped by a partial earlier run, and on nodes where it was empty.
 *
 * Sender derivation mirrors the runtime (HandleGCR.runGroup):
 *     pubkey = tx.content.from_ed25519_address || tx.content.from
 * The same two columns exist on `transactions` as top-level fields.
 *
 * Idempotent on re-run: CREATE TABLE IF NOT EXISTS, INSERT … ON CONFLICT
 * DO NOTHING, and ALTER TABLE DROP COLUMN IF EXISTS.
 *
 * The dead TOAST left behind on `gcr_main` is not reclaimed by this
 * migration. Run separately post-deploy:
 *   psql -c "VACUUM (FULL, ANALYZE) gcr_main"
 */
export class MoveAssignedTxsToOwnTable1715000000000
    implements MigrationInterface
{
    public async up(qr: QueryRunner): Promise<void> {
        // 1) Create the new relation.
        await qr.query(`
            CREATE TABLE IF NOT EXISTS "gcr_assigned_txs" (
                "pubkey" text NOT NULL,
                "tx_hash" text NOT NULL,
                "block_number" integer NOT NULL DEFAULT 0,
                "assigned_at" timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY ("pubkey", "tx_hash")
            )
        `)
        await qr.query(`
            CREATE INDEX IF NOT EXISTS "idx_gcr_assigned_txs_pubkey"
                ON "gcr_assigned_txs" ("pubkey", "block_number" DESC)
        `)

        // 2) Backfill from `transactions`. The sender expression mirrors the
        //    runtime's `from_ed25519_address || from` preference (treating
        //    empty strings as falsy, same as JavaScript ||).
        const inserted = (await qr.query(`
            INSERT INTO "gcr_assigned_txs" ("pubkey", "tx_hash", "block_number")
            SELECT
                COALESCE(NULLIF(t."from_ed25519_address", ''), t."from") AS pubkey,
                t."hash",
                t."blockNumber"
            FROM "transactions" t
            WHERE COALESCE(NULLIF(t."from_ed25519_address", ''), t."from") IS NOT NULL
              AND t."hash" IS NOT NULL
            ON CONFLICT ("pubkey", "tx_hash") DO NOTHING
            RETURNING 1
        `)) as unknown[]

        console.log(
            `[MoveAssignedTxsToOwnTable] backfilled ${inserted.length} row(s) ` +
                `from transactions into gcr_assigned_txs`,
        )

        // 3) Drop the now-unused source column if it still exists. IF EXISTS
        //    makes this idempotent across nodes in different states (some may
        //    have had it dropped by a partial earlier run; some never had it
        //    in the first place on truly fresh installs).
        await qr.query(
            `ALTER TABLE "gcr_main" DROP COLUMN IF EXISTS "assignedTxs"`,
        )
    }

    public async down(qr: QueryRunner): Promise<void> {
        // Restore the column and rebuild the jsonb array from the new table.
        // Order is best-effort by block_number, since the original semantic
        // was append-order. New table → old column is a lossy round-trip if
        // any rows were added after migration (block_number reflects when
        // the tx was applied, not when it was assigned), but it's the closest
        // approximation available.
        await qr.query(`
            ALTER TABLE "gcr_main"
            ADD COLUMN IF NOT EXISTS "assignedTxs" jsonb NOT NULL DEFAULT '[]'::jsonb
        `)
        await qr.query(`
            UPDATE "gcr_main" g
            SET "assignedTxs" = COALESCE(
                (SELECT jsonb_agg(a."tx_hash" ORDER BY a."block_number", a."assigned_at")
                   FROM "gcr_assigned_txs" a
                  WHERE a."pubkey" = g."pubkey"),
                '[]'::jsonb
            )
        `)
        await qr.query(`DROP TABLE IF EXISTS "gcr_assigned_txs"`)
    }
}
