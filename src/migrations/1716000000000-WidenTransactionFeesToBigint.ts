import { MigrationInterface, QueryRunner } from "typeorm"

const FEE_COLUMNS = ["networkFee", "rpcFee", "additionalFee"] as const

/**
 * Widens `transactions."networkFee" | "rpcFee" | "additionalFee"` from
 * `integer` to `bigint`.
 *
 * Why: the entity types and the SDK's `RawTransaction` were widened to
 * carry fee amounts as `bigint` / OS-denominated values that can exceed
 * the 32-bit signed integer range. The boundary helper
 * `toTransactionsEntity` (src/libs/blockchain/transaction.ts) now coerces
 * every fee through `BigInt(...)` before `entityManager.save()` — but the
 * underlying column was still `integer`, so any fee that exceeded 2^31-1
 * (or carried sub-DEM precision on a misbehaving sender) hit
 * `invalid input syntax for type bigint`-style Postgres errors at insert
 * time and aborted the whole block-insert transaction.
 *
 * `amount` is already `bigint` in the baseline; only the three fee
 * columns need widening.
 *
 * Performance: int4 → int8 changes the on-disk row layout, so Postgres
 * MUST rewrite the heap; there is no metadata-only fast path. The cost
 * scales with table size — on a million-row `transactions` table this is
 * minutes, not seconds. The mitigation here is to batch all three column
 * changes into a single `ALTER TABLE` statement: Postgres collapses
 * multiple `ALTER COLUMN` clauses on the same table into ONE rewrite
 * pass, so we pay the heap-rewrite cost once instead of three times. The
 * single statement also takes `ACCESS EXCLUSIVE` once instead of three
 * times in succession.
 *
 * `integer` → `bigint` is a widening cast and does not need a `USING`
 * clause; every existing value is preserved exactly.
 *
 * Idempotent: re-checks `information_schema.columns` and only includes
 * columns that are still `integer`. If all three are already `bigint` the
 * migration is a no-op.
 */
export class WidenTransactionFeesToBigint1716000000000
    implements MigrationInterface
{
    public async up(qr: QueryRunner): Promise<void> {
        const toWiden = await this.columnsByType(qr, "integer", "bigint")
        if (toWiden.length === 0) return

        const clauses = toWiden
            .map(c => `ALTER COLUMN "${c}" TYPE bigint`)
            .join(", ")
        await qr.query(`ALTER TABLE "transactions" ${clauses}`)
    }

    public async down(qr: QueryRunner): Promise<void> {
        // bigint → integer is narrowing and can lose data. The `USING`
        // cast will raise `integer out of range` on any row whose value
        // exceeds 2^31-1, which is the correct failure mode for an
        // incomplete rollback rather than silently truncating fees.
        const toNarrow = await this.columnsByType(qr, "bigint", "integer")
        if (toNarrow.length === 0) return

        const clauses = toNarrow
            .map(c => `ALTER COLUMN "${c}" TYPE integer USING "${c}"::integer`)
            .join(", ")
        await qr.query(`ALTER TABLE "transactions" ${clauses}`)
    }

    /**
     * Return the subset of fee columns whose current `data_type` is
     * `expected` (= "needs migrating"). Columns already at `target` are
     * skipped. Anything else throws — surfaces an unexpected schema
     * rather than silently coercing.
     */
    private async columnsByType(
        qr: QueryRunner,
        expected: "integer" | "bigint",
        target: "integer" | "bigint",
    ): Promise<string[]> {
        const rows = (await qr.query(
            `SELECT column_name, data_type
               FROM information_schema.columns
              WHERE table_name = 'transactions'
                AND column_name = ANY($1)`,
            [FEE_COLUMNS as readonly string[]],
        )) as Array<{ column_name: string; data_type: string }>

        const byName = new Map(rows.map(r => [r.column_name, r.data_type]))
        const out: string[] = []
        for (const c of FEE_COLUMNS) {
            const current = byName.get(c)
            if (current === target) continue
            if (current !== expected) {
                throw new Error(
                    `[WidenTransactionFeesToBigint] unexpected data_type ` +
                        `"${current}" for transactions."${c}"; expected ` +
                        `"${expected}" or "${target}"`,
                )
            }
            out.push(c)
        }
        return out
    }
}
