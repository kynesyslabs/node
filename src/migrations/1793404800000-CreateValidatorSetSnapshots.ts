/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The validator set after block 0 and after every block that changed it.
 * The live validators table only holds the present, so committee selection
 * and the `validator_set_hash` commitment of a past height read these rows.
 */
export class CreateValidatorSetSnapshots1793404800000 implements MigrationInterface {
    name = "CreateValidatorSetSnapshots1793404800000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "validator_set_snapshots" (
                "block" integer NOT NULL,
                "set_hash" text NOT NULL,
                "validators" jsonb NOT NULL,
                CONSTRAINT "PK_validator_set_snapshots" PRIMARY KEY ("block")
            )`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP TABLE IF EXISTS \"validator_set_snapshots\"")
    }
}
