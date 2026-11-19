/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Per-subnet L2PS nonces on the account row (docs/design/l2ps-zk-settlement.md,
 * "L2PS nonce"). Every existing account starts with none. That is sound only
 * on a chain where no private transfer has settled yet: one settled against
 * the L1 nonce could otherwise be settled again, so a chain with settled
 * private transfers restarts from a fresh genesis instead.
 */
export class AddL2PSNonces1794355200000 implements MigrationInterface {
    name = "AddL2PSNonces1794355200000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"gcr_main\" ADD COLUMN IF NOT EXISTS \"l2psNonces\" jsonb NOT NULL DEFAULT '{}'",
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "ALTER TABLE \"gcr_main\" DROP COLUMN IF EXISTS \"l2psNonces\"",
        )
    }
}
