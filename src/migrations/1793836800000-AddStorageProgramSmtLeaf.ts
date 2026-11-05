/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Each storage program's leaf in the storage state root, kept with the row so
 * the root is rebuilt from one narrow column instead of every program's data.
 * Existing rows start null; the root computes their leaves on first use.
 */
export class AddStorageProgramSmtLeaf1793836800000 implements MigrationInterface {
    name = "AddStorageProgramSmtLeaf1793836800000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"gcr_storageprogram\" ADD COLUMN IF NOT EXISTS \"smtLeaf\" text",
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"gcr_storageprogram\" DROP COLUMN IF EXISTS \"smtLeaf\"",
        )
    }
}
