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
    fetchPeerGenesis: () => Promise<unknown | null>
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
 * The advertised hash is the full hash of the genesis block a peer stored when
 * its chain was created, and that block is never refreshed. An operator who
 * schedules a fork on a running chain edits the file, so the file's full hash
 * differs from every peer's although nothing a node must share since block 0
 * does. Overwriting the file in that case would drop the schedule at the next
 * restart, so the core hash decides, and when a real difference does force a
 * replacement the local schedule and chain id are kept.
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
