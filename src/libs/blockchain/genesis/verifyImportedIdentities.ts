/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { expectedImportedIdentities, importedIdentityDigest } from "./carryover"
import { declaredManifestHash } from "./genesisPin"
import type { SnapshotLoader } from "./loadSnapshot"

export type ImportedIdentityReaders = {
    /** sha256 of the snapshot manifest on disk, null when there is none. */
    manifestHash: () => Promise<string | null>
    loadSnapshot: () => Promise<SnapshotLoader>
    /** Every identity_key in genesis_imported_identities. */
    storedKeys: () => Promise<string[]>
}

/**
 * Checks the imported-identity registry against the snapshot block 0 was
 * built from. Neither the registry nor points enter the state hash, so a node
 * whose registry drifted would pay or withhold first-link awards differently
 * from its peers without any consensus check noticing.
 *
 * Returns the reasons to refuse the boot; empty when the registry matches or
 * identityCarryover is not active at genesis.
 */
export async function importedIdentityProblems(
    storedGenesisData: unknown,
    carryoverAtGenesis: boolean,
    readers: ImportedIdentityReaders,
): Promise<string[]> {
    if (!carryoverAtGenesis) return []

    const actual = importedIdentityDigest(await readers.storedKeys())
    const declared = declaredManifestHash(storedGenesisData)
    if (declared === null) {
        // Such a block 0 restored nothing, so the registry must be empty.
        return actual.count === 0
            ? []
            : [
                  `genesis_imported_identities holds ${actual.count} rows but block 0 ` +
                      "declares no snapshot",
              ]
    }

    const onDisk = await readers.manifestHash()
    if (onDisk === null) {
        return [
            "identityCarryover is active at genesis and the imported-identity registry " +
                "is checked against the snapshot, but no snapshot manifest was found " +
                "(data/snapshot, or DEMOS_SNAPSHOT_DIR)",
        ]
    }
    if (onDisk !== declared) {
        return [`snapshot manifest hashes to ${onDisk}, block 0 declares ${declared}`]
    }
    const loader = await readers.loadSnapshot()
    if (!loader.available) {
        return ["the snapshot manifest is present but the snapshot could not be loaded"]
    }
    const expected = await expectedImportedIdentities(loader)
    if (expected.count !== actual.count || expected.digest !== actual.digest) {
        return [
            `genesis_imported_identities holds ${actual.count} keys (digest ${actual.digest}), ` +
                `the snapshot gives ${expected.count} (digest ${expected.digest}); ` +
                "wipe the database and rebuild block 0",
        ]
    }
    return []
}
