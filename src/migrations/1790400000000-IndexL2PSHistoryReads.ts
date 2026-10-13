/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Index what the history reads and the retention sweep actually filter on.
 *
 * The account history query selects on subnet and one party, then sorts
 * newest first by timestamp. The two-column party indexes cannot serve that
 * sort, so a busy account was sorted in memory on every page. Extending each
 * with `timestamp` makes them a strict superset, so the old pair is replaced
 * rather than kept alongside.
 *
 * Retention deletes by `created_at`, which nothing indexed, so every sweep
 * scanned the whole table.
 */
export class IndexL2PSHistoryReads1790400000000 implements MigrationInterface {
    name = "IndexL2PSHistoryReads1790400000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_L2PS_TX_UID_FROM_TIMESTAMP" ON "l2ps_transactions" ("l2ps_uid", "from_address", "timestamp")`,
        )
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_L2PS_TX_UID_TO_TIMESTAMP" ON "l2ps_transactions" ("l2ps_uid", "to_address", "timestamp")`,
        )
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_L2PS_TX_CREATED_AT" ON "l2ps_transactions" ("created_at")`,
        )
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_L2PS_TX_UID_FROM"`)
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_L2PS_TX_UID_TO"`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_L2PS_TX_UID_FROM" ON "l2ps_transactions" ("l2ps_uid", "from_address")`,
        )
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_L2PS_TX_UID_TO" ON "l2ps_transactions" ("l2ps_uid", "to_address")`,
        )
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_L2PS_TX_CREATED_AT"`)
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_L2PS_TX_UID_TO_TIMESTAMP"`,
        )
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_L2PS_TX_UID_FROM_TIMESTAMP"`,
        )
    }
}
