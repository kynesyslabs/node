/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The fork schedule a node last booted with. The schedule is re-read from the
 * genesis file at every boot; a restart compares it with this row so that an
 * edit at a height the chain is about to pass, or has passed, is refused
 * instead of loaded. One row, keyed by a constant.
 */
export class CreateAcceptedForkSchedule1793318400000 implements MigrationInterface {
    name = "CreateAcceptedForkSchedule1793318400000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "accepted_fork_schedule" (
                "id" text NOT NULL,
                "schedule" jsonb NOT NULL,
                "digest" text NOT NULL,
                "accepted_at_tip" bigint NOT NULL,
                "accepted_at" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_accepted_fork_schedule" PRIMARY KEY ("id")
            )`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "accepted_fork_schedule"`)
    }
}
