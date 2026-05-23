/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * REVIEW
 * Widens `gcr_main.balance` from `bigint` (signed 64-bit, max ~9.22e18) to
 * `numeric(38, 0)` (arbitrary precision, **integer-only**). This is required
 * for the osDenomination fork migration — `UPDATE gcr_main SET balance =
 * balance * 1000000000` overflows `bigint` on the production-genesis seed
 * magnitudes (10^18 × 10^9 = 10^27, well past the signed-64 ceiling).
 * Numeric has no fixed precision limit so the multiplication can complete
 * in-place.
 *
 * **Integer-only invariant** (myc#85, GH#3213220467): the entity-level
 * type is `bigint` and the application + ORM transformer assume integer
 * values. A malformed raw SQL caller could otherwise write a fractional
 * value, and the transformer's `from()` would feed it to `BigInt()` which
 * rejects fractional strings. Pinning the column to `numeric(38, 0)`
 * (zero scale) lets the database reject fractional writes at the
 * column-type level, comfortably covering the 1e27 OS magnitude ceiling
 * (38 decimal digits ≫ 28). The widening is the same diff as before —
 * we just constrain the scale.
 *
 * The application reads `balance` as `bigint`; a TypeORM transformer
 * (`bigintNumericTransformer` in `src/model/entities/transformers.ts`)
 * preserves that type at the ORM boundary so existing call sites continue
 * to compile and behave identically. Raw `entityManager.query` callers must
 * coerce via `BigInt(row.balance)` — this was already the established
 * convention for the previous `bigint` column (the pg driver returned it
 * as a string too).
 *
 * The `USING balance::numeric(38, 0)` clause is required because Postgres
 * won't implicitly cast `bigint` → `numeric(38, 0)` on a column type
 * change.
 *
 * `synchronize: true` in `datasource.ts` will perform the widening
 * automatically on startup, but this migration is checked in so production
 * deployments can run it deterministically (and so the schema change is
 * reviewable in PR diff form rather than buried in TypeORM auto-sync logs).
 */
export class WidenGcrMainBalanceToNumeric1714694400000
    implements MigrationInterface
{
    name = "WidenGcrMainBalanceToNumeric1714694400000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"gcr_main\" ALTER COLUMN \"balance\" TYPE numeric(38, 0) USING \"balance\"::numeric(38, 0)",
        )
        await queryRunner.query(
            "ALTER TABLE \"gcr_main\" ALTER COLUMN \"balance\" SET DEFAULT '0'",
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Narrow back to bigint. Will fail at runtime if any row holds a
        // value > BIGINT max (9.22e18) — which is the desired safety
        // behavior: post-fork OS balances are 10^9× larger than DEM, so
        // an account holding 10^10 DEM (= 10^19 OS) cannot be downcast
        // without precision loss. Operators must reconcile such rows
        // before reverting.
        await queryRunner.query(
            "ALTER TABLE \"gcr_main\" ALTER COLUMN \"balance\" TYPE bigint USING \"balance\"::bigint",
        )
    }
}
