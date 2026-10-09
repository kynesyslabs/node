/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * `message_hash` was unique across the whole table, but clients send one
 * message to several recipients under the same hash (the SDK channel
 * transport uses the envelope signature), and two senders can produce the
 * same hash. Every send after the first was refused as a duplicate.
 *
 * The hash is now unique per subnet, sender and recipient. The old
 * constraint was created inline, so its name is whatever Postgres chose;
 * it is looked up rather than assumed.
 */
export class ScopeL2PSMessageHashUnique1791504000000
    implements MigrationInterface
{
    name = "ScopeL2PSMessageHashUnique1791504000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$
            DECLARE c record;
            BEGIN
                FOR c IN
                    SELECT con.conname
                    FROM pg_constraint con
                    JOIN pg_class rel ON rel.oid = con.conrelid
                    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
                    WHERE rel.relname = 'l2ps_messages'
                      AND con.contype = 'u'
                      AND array_length(con.conkey, 1) = 1
                      AND att.attname = 'message_hash'
                LOOP
                    EXECUTE format('ALTER TABLE "l2ps_messages" DROP CONSTRAINT %I', c.conname);
                END LOOP;
            END $$;
        `)

        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_l2ps_messages_sender_recipient_hash"
            ON "l2ps_messages" ("l2ps_uid", "from_key", "to_key", "message_hash")
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "DROP INDEX IF EXISTS \"UQ_l2ps_messages_sender_recipient_hash\"",
        )
        // Fails if rows now share a hash across recipients; those have to be
        // removed by hand before rolling back.
        await queryRunner.query(
            "ALTER TABLE \"l2ps_messages\" ADD CONSTRAINT \"l2ps_messages_message_hash_key\" UNIQUE (\"message_hash\")",
        )
    }
}
