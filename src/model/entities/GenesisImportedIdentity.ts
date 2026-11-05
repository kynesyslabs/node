/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Entity, PrimaryColumn } from "typeorm"

/**
 * One identity the genesis snapshot import carried over, by the key
 * `firstConnectionKey` builds (src/libs/blockchain/genesis/carryover.ts).
 * Written once with block 0 and only read afterwards; every node builds the
 * same rows from the same bound snapshot, so the table is never hashed.
 */
@Entity("genesis_imported_identities")
export class GenesisImportedIdentity {
    @PrimaryColumn("text", { name: "identity_key" })
    identityKey: string
}
