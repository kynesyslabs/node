/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Widen the four money-shaped columns on `transactions` from PG `bigint`
 * (int8, max ≈ 9.22 × 10^18) to `numeric(38, 0)` so post-fork OS values
 * cannot overflow at INSERT time.
 *
 * Concretely: a 10 % transfer out of a 10^18 DEM genesis-funded account
 * is 10^17 DEM × 10^9 OS/DEM = 10^26 OS — three orders of magnitude past
 * `int8`'s ceiling. Pre-this-migration, `validateTransaction` accepted
 * the tx (`getAccountBalance` is already `numeric(38, 0)` via
 * `gcr_main.balance`) but `insertBlock` crashed the consensus loop with:
 *
 *     QueryFailedError: value "100000000000000000000000000" is out of
 *                       range for type bigint
 *
 * Postgres allows `ALTER COLUMN … TYPE numeric(38, 0)` against an
 * existing `bigint` column with an implicit USING cast — every existing
 * `bigint` value is representable as a `numeric(38, 0)`, so no data
 * loss is possible.
 *
 * Defaults are restored explicitly because `ALTER COLUMN … TYPE` drops
 * the previous default when the underlying type changes. The
 * application-layer entity reads these as `bigint` via the
 * `bigintNumericTransformer` (same transformer used by `gcr_main.balance`).
 */
export class WidenTransactionsMoneyColsToNumeric1779834000000
    implements MigrationInterface
{
    name = "WidenTransactionsMoneyColsToNumeric1779834000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        // `amount` is nullable with no default.
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "amount" TYPE numeric(38, 0)`,
        )
        // Fee columns are nullable with default 0.
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "networkFee" DROP DEFAULT`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "networkFee" TYPE numeric(38, 0)`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "networkFee" SET DEFAULT 0`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "rpcFee" DROP DEFAULT`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "rpcFee" TYPE numeric(38, 0)`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "rpcFee" SET DEFAULT 0`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "additionalFee" DROP DEFAULT`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "additionalFee" TYPE numeric(38, 0)`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "additionalFee" SET DEFAULT 0`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse direction: `numeric(38, 0)` → `bigint`. This narrowing is
        // LOSSY for any row whose value exceeds 9.22 × 10^18; Postgres will
        // throw on the offending row rather than silently truncate. That is
        // the right behaviour — a successful down-migration on a chain
        // that has already accepted post-fork-magnitude txs would corrupt
        // the historical ledger. Operators MUST snapshot before running
        // this down-migration and accept that they cannot reverse without
        // wiping any post-fork OS magnitudes from `transactions`.
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "additionalFee" DROP DEFAULT`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "additionalFee" TYPE bigint USING "additionalFee"::bigint`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "additionalFee" SET DEFAULT 0`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "rpcFee" DROP DEFAULT`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "rpcFee" TYPE bigint USING "rpcFee"::bigint`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "rpcFee" SET DEFAULT 0`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "networkFee" DROP DEFAULT`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "networkFee" TYPE bigint USING "networkFee"::bigint`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "networkFee" SET DEFAULT 0`,
        )
        await queryRunner.query(
            `ALTER TABLE "transactions" ALTER COLUMN "amount" TYPE bigint USING "amount"::bigint`,
        )
    }
}
