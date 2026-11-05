/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The first block the storage undo log holds: the one after the head when
 * the log is created. Blocks before it were applied without undo rows, so a
 * storage proof cannot be rebuilt at them.
 */
export class RecordStorageHistoryStart1794009600000 implements MigrationInterface {
    name = "RecordStorageHistoryStart1794009600000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "storage_program_history_start" (
                "id" smallint NOT NULL DEFAULT 1,
                "block" integer NOT NULL,
                CONSTRAINT "PK_storage_program_history_start" PRIMARY KEY ("id"),
                CONSTRAINT "CHK_storage_program_history_start_one_row" CHECK ("id" = 1)
            )`,
        )
        await queryRunner.query(
            `INSERT INTO "storage_program_history_start" ("id", "block")
             SELECT 1, COALESCE(MAX("number"), 0) + 1 FROM "blocks"
             ON CONFLICT ("id") DO NOTHING`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP TABLE IF EXISTS \"storage_program_history_start\"")
    }
}
