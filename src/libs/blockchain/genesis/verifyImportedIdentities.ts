/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { identityCarryoverScheduledAtZero } from "@/forks/identityCarryoverGate"
import { expectedImportedIdentities, importedIdentityDigest } from "./carryover"
import { declaredManifestHash } from "./genesisPin"
import type { BoundGcrMain } from "./loadSnapshot"

export type ImportedIdentityReaders = {
    /** gcr_main.jsonl of the snapshot whose manifest hashes to the given sha256. */
    openGcrMain: (manifestSha256: string) => Promise<BoundGcrMain>
    /** Every identity_key in genesis_imported_identities. */
    storedKeys: () => Promise<string[]>
}

/**
 * Checks the imported-identity registry against the snapshot block 0 was
 * built from. Neither the registry nor points enter the state hash, so a node
 * whose registry drifted would pay or withhold first-link awards differently
 * from its peers without any consensus check noticing.
 *
 * Whether the check applies is read from block 0's stored genesis, not from
 * data/genesis.json: a missing or edited file must not skip it.
 *
 * Returns the reasons to refuse the boot; empty when the registry matches or
 * block 0 does not schedule identityCarryover at 0.
 */
export async function importedIdentityProblems(
    storedGenesisData: unknown,
    readers: ImportedIdentityReaders,
): Promise<string[]> {
    if (!identityCarryoverScheduledAtZero(storedGenesisData)) return []

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

    const gcrMain = await readers.openGcrMain(declared)
    if (gcrMain.status === "missing") {
        return [
            "identityCarryover is active at genesis and the imported-identity registry " +
                "is checked against the snapshot, but no snapshot manifest was found " +
                "(data/snapshot, or DEMOS_SNAPSHOT_DIR)",
        ]
    }
    if (gcrMain.status === "mismatch") {
        return [`snapshot manifest hashes to ${gcrMain.manifestSha256}, block 0 declares ${declared}`]
    }
    if (gcrMain.status === "unreadable") {
        return [
            `the snapshot manifest is present but the snapshot could not be loaded: ${gcrMain.reason}`,
        ]
    }
    const expected = await expectedImportedIdentities(gcrMain)
    if (expected.count !== actual.count || expected.digest !== actual.digest) {
        return [
            `genesis_imported_identities holds ${actual.count} keys (digest ${actual.digest}), ` +
                `the snapshot gives ${expected.count} (digest ${expected.digest}); ` +
                "wipe the database and rebuild block 0",
        ]
    }
    return []
}
