/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * REVIEW
 * Widens the fee columns on the `transactions` table from `integer` (32-bit)
 * to `bigint` (64-bit). The columns previously held DEM-denominated fees
 * which fit in 32 bits today; widening makes them safe for OS-denominated
 * fees once the DEM -> OS migration lands. This migration is a pure column
 * widening: no row-level data conversion is required because every existing
 * value already fits in `bigint`.
 *
 * `synchronize: true` in `datasource.ts` will perform the widening
 * automatically on startup, but this migration is checked in so production
 * deployments can run it deterministically.
 */
export class WidenFeeColumnsToBigint1714521600000
    implements MigrationInterface
{
    name = "WidenFeeColumnsToBigint1714521600000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Widen type first.
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"networkFee\" TYPE bigint USING \"networkFee\"::bigint",
        )
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"rpcFee\" TYPE bigint USING \"rpcFee\"::bigint",
        )
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"additionalFee\" TYPE bigint USING \"additionalFee\"::bigint",
        )
        // Backfill any NULL rows from older databases that predate the
        // entity declaration. Without this, a `synchronize: true` boot
        // against a legacy DB fails when TypeORM tries to enforce NOT
        // NULL on rows containing nulls. The entity itself declares the
        // columns `nullable: true, default: 0` so the boot path doesn't
        // depend on this migration having run, but the migration sets
        // the DB-side default for deterministic prod deploys.
        await queryRunner.query(
            "UPDATE \"transactions\" SET \"networkFee\" = 0 WHERE \"networkFee\" IS NULL",
        )
        await queryRunner.query(
            "UPDATE \"transactions\" SET \"rpcFee\" = 0 WHERE \"rpcFee\" IS NULL",
        )
        await queryRunner.query(
            "UPDATE \"transactions\" SET \"additionalFee\" = 0 WHERE \"additionalFee\" IS NULL",
        )
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"networkFee\" SET DEFAULT 0",
        )
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"rpcFee\" SET DEFAULT 0",
        )
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"additionalFee\" SET DEFAULT 0",
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Narrow back to integer. Will fail at runtime if any row holds a
        // value > INT_MAX, which is the desired safety behavior.
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"networkFee\" TYPE integer USING \"networkFee\"::integer",
        )
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"rpcFee\" TYPE integer USING \"rpcFee\"::integer",
        )
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"additionalFee\" TYPE integer USING \"additionalFee\"::integer",
        )
    }
}
