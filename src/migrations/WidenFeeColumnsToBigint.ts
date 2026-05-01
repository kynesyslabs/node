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
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"networkFee\" TYPE bigint USING \"networkFee\"::bigint",
        )
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"rpcFee\" TYPE bigint USING \"rpcFee\"::bigint",
        )
        await queryRunner.query(
            "ALTER TABLE \"transactions\" ALTER COLUMN \"additionalFee\" TYPE bigint USING \"additionalFee\"::bigint",
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
