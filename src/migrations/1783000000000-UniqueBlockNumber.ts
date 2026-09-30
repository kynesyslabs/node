/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Deduplicate blocks (keeping the earliest row per number) and enforce
 * uniqueness on blocks.number, so a concurrent double-apply fails loudly
 * at insert instead of silently corrupting the table.
 */
export class UniqueBlockNumber1783000000000 implements MigrationInterface {
    name = "UniqueBlockNumber1783000000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        const conflicting: { number: number; variants: string }[] =
            await queryRunner.query(
                `SELECT "number", string_agg(DISTINCT "hash", ', ') AS variants
                 FROM "blocks"
                 GROUP BY "number"
                 HAVING COUNT(*) > 1 AND COUNT(DISTINCT "hash") > 1`,
            )
        for (const row of conflicting) {
            console.warn(
                `[UniqueBlockNumber] block ${row.number} has conflicting variants (${row.variants}); keeping the earliest row`,
            )
        }

        await queryRunner.query(
            `DELETE FROM "blocks" b
             USING "blocks" keep
             WHERE b."number" = keep."number" AND b."id" > keep."id"`,
        )

        await queryRunner.query("DROP INDEX IF EXISTS \"idx_blocks_number\"")
        await queryRunner.query(
            "CREATE UNIQUE INDEX \"idx_blocks_number\" ON \"blocks\" (\"number\")",
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP INDEX IF EXISTS \"idx_blocks_number\"")
        await queryRunner.query(
            "CREATE INDEX \"idx_blocks_number\" ON \"blocks\" (\"number\")",
        )
    }
}
