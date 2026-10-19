/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Keep the replay guard across history retention.
 *
 * `hasExecuted` answers from `l2ps_transactions`, and `pruneHistory` deletes
 * from it once `l2ps.historyRetentionDays` is set. The mempool rows are swept
 * long before that, so after a prune nothing remembered that the transaction
 * had run. Pruning now moves each deleted row's hash here in the same
 * statement, and the replay check reads both tables.
 */
export class CreateL2PSExecutedHashes1790208000000 implements MigrationInterface {
    name = "CreateL2PSExecutedHashes1790208000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "l2ps_executed_hashes" (
                "hash" text NOT NULL,
                "l2ps_uid" text NOT NULL,
                "pruned_at" timestamp NOT NULL DEFAULT now(),
                CONSTRAINT "PK_l2ps_executed_hashes" PRIMARY KEY ("hash")
            )`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "l2ps_executed_hashes"`)
    }
}
