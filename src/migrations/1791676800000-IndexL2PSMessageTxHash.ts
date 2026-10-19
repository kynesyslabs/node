/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Index `l2ps_tx_hash` on messages.
 *
 * The backlog guard counts a subnet's executed queue rows that came from
 * messaging by matching them to this column every few seconds. Without an
 * index each count would scan the whole message table, which only grows.
 * Rows not yet submitted hold NULL and are left out.
 */
export class IndexL2PSMessageTxHash1791676800000 implements MigrationInterface {
    name = "IndexL2PSMessageTxHash1791676800000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        // An index build on a large table outlives the default timeouts; see
        // IndexL2PSEncryptedHash for why this is SET LOCAL and not CONCURRENTLY.
        await queryRunner.query("SET LOCAL statement_timeout = 0")
        await queryRunner.query("SET LOCAL lock_timeout = 0")
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_l2ps_messages_tx_hash" ON "l2ps_messages" ("l2ps_tx_hash") WHERE "l2ps_tx_hash" IS NOT NULL`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_l2ps_messages_tx_hash"`)
    }
}
