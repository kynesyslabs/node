/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Identities a genesis snapshot import carried over, so a first-link award is
 * not paid for them again under identityCarryover. Filled with block 0.
 */
export class CreateGenesisImportedIdentities1794096000000 implements MigrationInterface {
    name = "CreateGenesisImportedIdentities1794096000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE IF NOT EXISTS "genesis_imported_identities" (
                "identity_key" text NOT NULL,
                CONSTRAINT "PK_genesis_imported_identities" PRIMARY KEY ("identity_key")
            )`,
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP TABLE IF EXISTS \"genesis_imported_identities\"")
    }
}
