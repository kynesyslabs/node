/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * REVIEW
 * Creates the `fork_state` table used by the P3b state migration to track
 * one-time DEM → OS conversion per fork. Schema mirrors
 * `src/model/entities/ForkState.ts`.
 *
 * `synchronize: true` in `datasource.ts` will create the table automatically
 * on startup, but this migration is checked in so production deployments
 * can run it deterministically (and so the schema is reviewable in PR diff
 * form, not buried in TypeORM auto-sync logs).
 *
 * Idempotency: the table is created with `IF NOT EXISTS` so re-running the
 * migration after `synchronize` is a no-op.
 */
export class CreateForkStateTable1714608000000 implements MigrationInterface {
    name = "CreateForkStateTable1714608000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "fork_state" (
                "fork_name" text PRIMARY KEY,
                "applied" boolean NOT NULL DEFAULT false,
                "applied_at_block" bigint,
                "applied_at" timestamp,
                "pre_sum_dem" text,
                "post_sum_os" text,
                "gcr_v2_row_count" integer,
                "legacy_row_count" integer,
                "validators_row_count" integer,
                "capped_count" integer,
                "total_value_lost_os" text
            )`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP TABLE IF EXISTS \"fork_state\"")
    }
}
