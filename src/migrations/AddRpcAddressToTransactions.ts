/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * DEM-665 — Adds the `rpcAddress` column to the `transactions` table.
 *
 * The column stores the ed25519 public key (lowercase hex, `0x` + 64 hex
 * chars) of the RPC node that validated each transaction. Post-fork the
 * fee-distribution logic reads this to route the `rpc_fee` portion to
 * the correct operator account.
 *
 * Nullable by design: pre-fork rows predate the field. Post-wipe chains
 * should have no pre-fork rows, but the column shape stays defensive
 * for any legacy/legacy-replay scenario.
 *
 * `synchronize: true` in `datasource.ts` would add the column
 * automatically on first boot of a node carrying this code; this
 * migration is checked in so production deployments can run it
 * deterministically.
 */
export class AddRpcAddressToTransactions1714780800000
    implements MigrationInterface
{
    name = "AddRpcAddressToTransactions1714780800000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "rpcAddress" varchar NULL',
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'ALTER TABLE "transactions" DROP COLUMN IF EXISTS "rpcAddress"',
        )
    }
}
