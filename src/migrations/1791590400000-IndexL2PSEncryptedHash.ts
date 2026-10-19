/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Index `encrypted_hash`.
 *
 * Consensus and the batch aggregator update a row by `hash` or by
 * `encrypted_hash`, because the proofs carry the encrypted one. The first has
 * an index; the second had none, so the OR could not use either and every
 * status update scanned the table. With history now kept, the table only
 * grows, and the scan grows with it.
 */
export class IndexL2PSEncryptedHash1791590400000 implements MigrationInterface {
    name = "IndexL2PSEncryptedHash1791590400000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        // An index build on a large table outlives the default timeouts.
        // Migrations run in one transaction, so SET LOCAL ends with it and
        // leaves nothing on the pooled connection to put back; a RESET in a
        // finally would instead fail inside the aborted transaction and hide
        // the error that aborted it. The build is not CONCURRENTLY for the
        // same reason: that cannot run in a transaction.
        await queryRunner.query("SET LOCAL statement_timeout = 0")
        await queryRunner.query("SET LOCAL lock_timeout = 0")
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_L2PS_TX_ENCRYPTED_HASH" ON "l2ps_transactions" ("encrypted_hash")`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_L2PS_TX_ENCRYPTED_HASH"`,
        )
    }
}
