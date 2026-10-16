/**
 * What a node does when the genesis data hash a peer advertises differs from
 * its own.
 *
 * Free of I/O imports so the decision can be tested; the caller passes the
 * network and file access in.
 */

export type GenesisMismatchOutcome =
    | { outcome: "match" }
    /**
     * The peer's data differs from the local file only in the fork schedule or
     * the chain id, which the core hash leaves out. The local file stays.
     */
    | { outcome: "unhashed-fields-only" }
    /**
     * The data really differs. The file now holds the peer's data with the
     * local `forks` and `properties.id` carried over.
     */
    | {
          outcome: "replaced"
          servedCoreHash: string
          writtenFullHash: string
          carriedOver: string[]
      }

export interface GenesisMismatchDeps {
    /** The peer's genesis data as it serves it, or null when it could not be fetched. */
    fetchPeerGenesis: () => Promise<unknown>
    readLocalGenesis: () => unknown
    writeGenesis: (data: unknown) => void
    /** The hash peers advertise and compare: covers everything in the stored block. */
    hashFull: (data: unknown) => string
    /** The hash without `forks` and `properties.id`. */
    hashCore: (data: unknown) => string
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v)
}

/**
 * Compare hashes and, only when the genesis data really differs, replace the
 * local file.
 *
 * The advertised hash covers the whole stored genesis block, including the
 * fork schedule and chain id, while an operator can add those to the local file
 * on a running chain. The file's full hash then differs from every peer's
 * though nothing shared since block 0 does, and overwriting the file would
 * drop the schedule at the next restart. The core hash therefore decides, and
 * when a real difference forces a replacement the local schedule and chain id
 * are kept.
 *
 * What the peer serves must hash, in full, to what it advertised: that is the
 * consistency check between the two answers.
 */
export async function resolveGenesisMismatch(
    ourFullHash: string,
    ourCoreHash: string,
    peerAdvertisedHash: string,
    deps: GenesisMismatchDeps,
): Promise<GenesisMismatchOutcome> {
    if (peerAdvertisedHash === ourFullHash) return { outcome: "match" }

    const served = await deps.fetchPeerGenesis()
    if (served === null) {
        throw new Error("Failed to download genesis data from peer")
    }
    const servedFull = deps.hashFull(served)
    if (servedFull !== peerAdvertisedHash) {
        throw new Error(
            `Genesis data hash mismatch after download: ${servedFull} != ${peerAdvertisedHash}`,
        )
    }

    const servedCore = deps.hashCore(served)
    if (servedCore === ourCoreHash) return { outcome: "unhashed-fields-only" }

    const local = deps.readLocalGenesis()
    const merged: Record<string, unknown> = isRecord(served) ? { ...served } : {}
    const carriedOver: string[] = []
    if (isRecord(local) && local.forks !== undefined) {
        merged.forks = local.forks
        carriedOver.push("forks")
    }
    if (
        isRecord(local) &&
        isRecord(local.properties) &&
        local.properties.id !== undefined
    ) {
        merged.properties = {
            ...(isRecord(merged.properties) ? merged.properties : {}),
            id: local.properties.id,
        }
        carriedOver.push("properties.id")
    }

    deps.writeGenesis(merged)
    const written = deps.readLocalGenesis()
    if (deps.hashCore(written) !== servedCore) {
        throw new Error(
            "Genesis data written from peer does not hash like what the peer served",
        )
    }
    return {
        outcome: "replaced",
        servedCoreHash: servedCore,
        writtenFullHash: deps.hashFull(written),
        carriedOver,
    }
}

/**
 * After a verdict of "unhashed-fields-only" the local file is kept as it is,
 * which is right for a node that already stores the network's block 0. A node
 * whose database was wiped has just created its block 0 from that edited file,
 * and what it stores hashes differently from what its peers advertise, so it
 * could never sync. The stored block's hash tells the two apart.
 *
 * Returns the explanation to log and throw, or null when the stored block 0
 * is the network's (or there is no stored block to judge).
 */
export function editedGenesisOnFreshChainProblem(
    storedGenesisHash: string | null,
    peerAdvertisedHash: string,
): string | null {
    if (storedGenesisHash === null || storedGenesisHash === peerAdvertisedHash) {
        return null
    }
    return (
        "The genesis block stored by this node (hash " +
        storedGenesisHash +
        ") differs from the network's (hash " +
        peerAdvertisedHash +
        ") only in the fork schedule or chain id, so this node created its block 0 from an " +
        "edited data/genesis.json and can never sync with its peers. Restore the genesis file " +
        "as it was when the chain was created, wipe the database, let block 0 be stored, and " +
        "only then add the forks entries and properties.id again and restart."
    )
}
