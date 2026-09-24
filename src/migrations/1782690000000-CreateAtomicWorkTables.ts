/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Backing tables for Work edits (`GCRAtomicWork`, `GCRResourceSlot`).
 * Empty until the `atomicWork` fork activates: every Work edit is refused
 * before that, so nothing writes here.
 */
export class CreateAtomicWorkTables1782690000000 implements MigrationInterface {
    name = "CreateAtomicWorkTables1782690000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "gcr_atomic_works" (
                "workId"             text PRIMARY KEY,
                "winnerAttemptId"    text NOT NULL,
                "canonicalBytesHash" text NOT NULL,
                "attemptClass"       text NOT NULL,
                "replacementFor"     text NULL,
                "txHash"             text NOT NULL,
                "receiptCommitment"  text NULL,
                "effectsRoot"        text NULL,
                "inputHash"          text NULL,
                "outputHash"         text NULL
            )
        `)
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "idx_gcr_atomic_works_txhash" ON "gcr_atomic_works" ("txHash")`,
        )
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "gcr_resource_slots" (
                "resourceKey" text PRIMARY KEY,
                "state"       text NOT NULL,
                "generation"  integer NOT NULL,
                "workId"      text NOT NULL,
                "record"      jsonb NOT NULL
            )
        `)
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "idx_gcr_resource_slots_work" ON "gcr_resource_slots" ("workId")`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "gcr_resource_slots"`)
        await queryRunner.query(`DROP TABLE IF EXISTS "gcr_atomic_works"`)
    }
}
