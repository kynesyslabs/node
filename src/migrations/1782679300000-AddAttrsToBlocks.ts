/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Add a nullable `attrs` JSONB column to `blocks` for arbitrary per-block
 * metadata. Mirrors the `transactions.attrs` column (AddAttrsToTransactions).
 *
 * `jsonb` (not `json`): stored decomposed/binary so it can be indexed
 * (GIN) and queried with the containment / path operators, unlike the
 * existing `content` / `validation_data` columns which are plain `json`
 * (text-preserving, no operator support). New metadata workloads want
 * querying, so `jsonb` is the right shape going forward.
 *
 * `nullable: true`, no default: every existing row predates the column,
 * so it backfills as NULL with no table rewrite of the existing data
 * (the ADD COLUMN is metadata-only on Postgres ≥ 11 because there is no
 * non-volatile default). Readers must treat a missing/NULL `attrs` as
 * "no metadata".
 */
export class AddAttrsToBlocks1782679300000 implements MigrationInterface {
    name = "AddAttrsToBlocks1782679300000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"blocks\" ADD COLUMN \"attrs\" jsonb",
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"blocks\" DROP COLUMN \"attrs\"",
        )
    }
}
