/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * The node NFT backing a validator seat: mint, the Solana wallet that held it
 * at stake time, and the proof transaction the wallet signed.
 */
export class AddValidatorNftColumns1794182400000 implements MigrationInterface {
    name = "AddValidatorNftColumns1794182400000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"validators\" ADD COLUMN IF NOT EXISTS \"nft_mint\" text",
        )
        await queryRunner.query(
            "ALTER TABLE \"validators\" ADD COLUMN IF NOT EXISTS \"nft_owner\" text",
        )
        await queryRunner.query(
            "ALTER TABLE \"validators\" ADD COLUMN IF NOT EXISTS \"nft_proof_tx\" text",
        )
        await queryRunner.query(
            "CREATE INDEX IF NOT EXISTS \"IDX_validators_nft_mint\" ON \"validators\" (\"nft_mint\")",
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP INDEX IF EXISTS \"IDX_validators_nft_mint\"")
        await queryRunner.query("ALTER TABLE \"validators\" DROP COLUMN IF EXISTS \"nft_proof_tx\"")
        await queryRunner.query("ALTER TABLE \"validators\" DROP COLUMN IF EXISTS \"nft_owner\"")
        await queryRunner.query("ALTER TABLE \"validators\" DROP COLUMN IF EXISTS \"nft_mint\"")
    }
}
