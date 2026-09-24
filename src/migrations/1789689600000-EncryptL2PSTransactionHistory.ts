/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Give `l2ps_transactions` the ciphertext, and stop requiring the plaintext.
 *
 * The table held the decrypted payload of every subnet transaction in
 * `content`, including message bodies, while the ciphertext lived only in the
 * aggregation queue that is swept five minutes after confirmation. That is
 * backwards on both counts: the copy that survives was the readable one, and
 * the copy peers need to sync was the one being deleted.
 *
 * `encrypted_payload` now carries the envelope as submitted, and `content`
 * becomes nullable so a node can be configured to keep no plaintext at all.
 * Rows written before this migration keep whatever they had; both columns are
 * read defensively.
 *
 * The extra index serves the `since` + newest-first paging the history reads
 * use, which previously had no covering index on the subnet scope.
 */
export class EncryptL2PSTransactionHistory1789689600000
    implements MigrationInterface
{
    name = "EncryptL2PSTransactionHistory1789689600000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("SET statement_timeout = 0")
        await queryRunner.query("SET lock_timeout = 0")
        await queryRunner.query(
            `ALTER TABLE "l2ps_transactions" ADD COLUMN IF NOT EXISTS "encrypted_payload" jsonb`,
        )
        await queryRunner.query(
            `ALTER TABLE "l2ps_transactions" ALTER COLUMN "content" DROP NOT NULL`,
        )
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_L2PS_TX_UID_TIMESTAMP" ON "l2ps_transactions" ("l2ps_uid", "timestamp")`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("SET statement_timeout = 0")
        await queryRunner.query("SET lock_timeout = 0")
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_L2PS_TX_UID_TIMESTAMP"`,
        )
        // Rows stored without plaintext cannot satisfy NOT NULL again, so the
        // reverse fills them with an empty object rather than failing.
        await queryRunner.query(
            `UPDATE "l2ps_transactions" SET "content" = '{}'::jsonb WHERE "content" IS NULL`,
        )
        await queryRunner.query(
            `ALTER TABLE "l2ps_transactions" ALTER COLUMN "content" SET NOT NULL`,
        )
        await queryRunner.query(
            `ALTER TABLE "l2ps_transactions" DROP COLUMN IF EXISTS "encrypted_payload"`,
        )
    }
}
