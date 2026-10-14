/**
 * What a node does when a peer's genesis data hash differs from its own.
 *
 * Kept free of I/O imports so the decision can be tested; the caller passes
 * the network and file access in.
 */

export type GenesisMismatchOutcome =
    | { outcome: "match" }
    /**
     * The peer serves genesis data that hashes like ours, so the difference is
     * only in fields the hash does not cover (the fork schedule, the chain
     * id), or the peer runs a build that still hashes them. The local file
     * stays as the operator wrote it.
     */
    | { outcome: "unhashed-fields-only"; servedHash: string }
    | { outcome: "replaced"; servedHash: string }

export interface GenesisMismatchDeps {
    /** The peer's genesis data as it serves it, or null when it could not be fetched. */
    fetchPeerGenesis: () => Promise<unknown | null>
    /** Replace the local genesis file with the given data. */
    writeGenesis: (data: unknown) => void
    /** Hash of the local file as read back after a write. */
    hashLocalFile: () => string
    hash: (data: unknown) => string
}

/**
 * Compare hashes and, only when the genesis data really differs, replace the
 * local file with the peer's.
 *
 * A peer's answer is computed from the genesis block stored when ITS chain was
 * created, and that block is never refreshed, so a difference confined to what
 * an operator legitimately edits on a running chain must not overwrite the
 * operator's file: that is how a fork schedule used to disappear at the next
 * restart.
 */
export async function resolveGenesisMismatch(
    ourHash: string,
    peerHash: string,
    deps: GenesisMismatchDeps,
): Promise<GenesisMismatchOutcome> {
    if (peerHash === ourHash) return { outcome: "match" }

    const served = await deps.fetchPeerGenesis()
    if (served === null) {
        throw new Error("Failed to download genesis data from peer")
    }
    const servedHash = deps.hash(served)
    if (servedHash === ourHash) {
        return { outcome: "unhashed-fields-only", servedHash }
    }

    deps.writeGenesis(served)
    const written = deps.hashLocalFile()
    if (written !== servedHash) {
        throw new Error(
            `Genesis data hash mismatch after download: ${written} != ${servedHash}`,
        )
    }
    return { outcome: "replaced", servedHash }
}
