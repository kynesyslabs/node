/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The part of a validator's stake that was debited from its balance, which
 * is what exit returns under stakeApplyChecks. Existing rows were never
 * debited, so they start at 0.
 */
export class AddValidatorBondedAmount1794182400000 implements MigrationInterface {
    name = "AddValidatorBondedAmount1794182400000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"validators\" ADD COLUMN IF NOT EXISTS \"bonded_amount\" text NOT NULL DEFAULT '0'",
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"validators\" DROP COLUMN IF EXISTS \"bonded_amount\"",
        )
    }
}
