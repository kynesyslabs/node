/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Under `tlsnVerified` a `tlsn_request` writes its token on chain as a
 * `gcr_tlsnotary` row with no proof yet, and the store fills it in. Rows
 * written before keep their values and get no status.
 */
export class TlsnOnChainTokens1794268800000 implements MigrationInterface {
    name = "TlsnOnChainTokens1794268800000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"gcr_tlsnotary\" ALTER COLUMN \"proof\" DROP NOT NULL",
        )
        await queryRunner.query(
            "ALTER TABLE \"gcr_tlsnotary\" ALTER COLUMN \"storageType\" DROP NOT NULL",
        )
        await queryRunner.query(
            "ALTER TABLE \"gcr_tlsnotary\" ADD COLUMN IF NOT EXISTS \"status\" text",
        )
        await queryRunner.query(
            "ALTER TABLE \"gcr_tlsnotary\" ADD COLUMN IF NOT EXISTS \"requestHeight\" integer",
        )
        await queryRunner.query(
            "ALTER TABLE \"gcr_tlsnotary\" ADD COLUMN IF NOT EXISTS \"expiresAtHeight\" integer",
        )
        await queryRunner.query(
            "ALTER TABLE \"gcr_tlsnotary\" ADD COLUMN IF NOT EXISTS \"attestationId\" text",
        )
        await queryRunner.query(
            "ALTER TABLE \"gcr_tlsnotary\" ADD COLUMN IF NOT EXISTS \"storedAtHeight\" integer",
        )
        await queryRunner.query(
            "CREATE UNIQUE INDEX IF NOT EXISTS \"idx_gcr_tlsnotary_attestation\" ON \"gcr_tlsnotary\" (\"attestationId\")",
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Pending tokens have no proof, so they cannot satisfy the old NOT NULL.
        await queryRunner.query(
            "DELETE FROM \"gcr_tlsnotary\" WHERE \"proof\" IS NULL OR \"storageType\" IS NULL",
        )
        await queryRunner.query("DROP INDEX IF EXISTS \"idx_gcr_tlsnotary_attestation\"")
        for (const column of ["storedAtHeight", "attestationId", "expiresAtHeight", "requestHeight", "status"]) {
            await queryRunner.query(
                `ALTER TABLE "gcr_tlsnotary" DROP COLUMN IF EXISTS "${column}"`,
            )
        }
        await queryRunner.query(
            "ALTER TABLE \"gcr_tlsnotary\" ALTER COLUMN \"storageType\" SET NOT NULL",
        )
        await queryRunner.query(
            "ALTER TABLE \"gcr_tlsnotary\" ALTER COLUMN \"proof\" SET NOT NULL",
        )
    }
}
