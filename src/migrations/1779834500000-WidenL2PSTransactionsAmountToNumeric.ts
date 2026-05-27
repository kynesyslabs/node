/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Same widening as `WidenTransactionsMoneyColsToNumeric1779834000000`,
 * applied to `l2ps_transactions.amount`. L2PS replays per-tx amounts
 * inside aggregated L1 batches, so a post-fork OS amount (e.g. 10^26
 * for a 10 % move out of a 10^18 DEM wallet) lands here too. Without
 * the widening, the column would reject any post-fork batch with
 * `value … is out of range for type bigint`, exactly the consensus-
 * breaking crash we fixed on the top-level `transactions` table.
 *
 * `numeric(38, 0)` lossless-casts from `bigint` (every int8 fits),
 * so `up` is safe. `down` is narrowing and lossy on any persisted
 * post-fork-magnitude row — operators must accept that.
 */
export class WidenL2PSTransactionsAmountToNumeric1779834500000
    implements MigrationInterface
{
    name = "WidenL2PSTransactionsAmountToNumeric1779834500000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "l2ps_transactions" ALTER COLUMN "amount" DROP DEFAULT`,
        )
        await queryRunner.query(
            `ALTER TABLE "l2ps_transactions" ALTER COLUMN "amount" TYPE numeric(38, 0)`,
        )
        await queryRunner.query(
            `ALTER TABLE "l2ps_transactions" ALTER COLUMN "amount" SET DEFAULT 0`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "l2ps_transactions" ALTER COLUMN "amount" DROP DEFAULT`,
        )
        await queryRunner.query(
            `ALTER TABLE "l2ps_transactions" ALTER COLUMN "amount" TYPE bigint USING "amount"::bigint`,
        )
        await queryRunner.query(
            `ALTER TABLE "l2ps_transactions" ALTER COLUMN "amount" SET DEFAULT 0`,
        )
    }
}
