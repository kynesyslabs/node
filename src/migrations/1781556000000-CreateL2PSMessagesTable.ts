/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Backing table for `L2PSMessage` (the WebSocket messaging sidecar).
 *
 * `datasource.ts` has `synchronize: false`, so adding the entity to the
 * `entities[]` array does not create the table. Without this migration,
 * every `processMessage`, `getQueuedMessages`, `markDelivered`,
 * `getHistory` call would throw `relation "l2ps_messages" does not exist`
 * the moment `L2PS_MESSAGING_ENABLED=true`.
 *
 * Single-column indexes mirror the entity's `@Index` decorators (used by
 * the unique-row reads); the two composite indexes below cover the
 * actual hot read paths (`getQueuedMessages` and `getHistory`), which
 * the single-column indexes would otherwise force a sort over.
 */
export class CreateL2PSMessagesTable1781556000000
    implements MigrationInterface
{
    name = "CreateL2PSMessagesTable1781556000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "l2ps_messages" (
                "id"           text PRIMARY KEY,
                "from_key"     text NOT NULL,
                "to_key"       text NOT NULL,
                "l2ps_uid"     text NOT NULL,
                "message_hash" text NOT NULL UNIQUE,
                "encrypted"    jsonb NOT NULL,
                "l2ps_tx_hash" text NULL,
                "timestamp"    bigint NOT NULL,
                "status"       text NOT NULL DEFAULT 'delivered'
            )
        `)

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_l2ps_messages_from_key" ON "l2ps_messages" ("from_key")`,
        )
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_l2ps_messages_to_key"   ON "l2ps_messages" ("to_key")`,
        )
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_l2ps_messages_l2ps_uid" ON "l2ps_messages" ("l2ps_uid")`,
        )

        // Composite index covering `getQueuedMessages`:
        //   WHERE to_key = $1 AND l2ps_uid = $2 AND status = 'queued'
        //   ORDER BY timestamp ASC
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_l2ps_messages_queued_for_recipient"
            ON "l2ps_messages" ("to_key", "l2ps_uid", "status", "timestamp")
        `)

        // Composite index covering `getHistory`:
        //   WHERE l2ps_uid = $1 AND (from_key = $2 OR to_key = $2)
        //   ORDER BY timestamp DESC
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_l2ps_messages_pair_history"
            ON "l2ps_messages" ("l2ps_uid", "timestamp" DESC)
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_l2ps_messages_pair_history"`,
        )
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_l2ps_messages_queued_for_recipient"`,
        )
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_l2ps_messages_l2ps_uid"`,
        )
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_l2ps_messages_to_key"`,
        )
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_l2ps_messages_from_key"`,
        )
        await queryRunner.query(`DROP TABLE IF EXISTS "l2ps_messages"`)
    }
}
