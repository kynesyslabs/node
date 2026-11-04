/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Undo log of the storage-program table over the last blocks: for each
 * program a block changed, its record before that block. A storage proof at
 * a recent block rebuilds that block's committed root by undoing the newer
 * rows. Local bookkeeping, never part of a block or a hash.
 */
export class CreateStorageProgramHistory1793923200000 implements MigrationInterface {
    name = "CreateStorageProgramHistory1793923200000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "storage_program_history" (
                "block" integer NOT NULL,
                "storageAddress" text NOT NULL,
                "record" jsonb,
                CONSTRAINT "PK_storage_program_history" PRIMARY KEY ("block", "storageAddress")
            )`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP TABLE IF EXISTS \"storage_program_history\"")
    }
}
