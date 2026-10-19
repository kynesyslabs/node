/**
 * What a node does when the genesis data hash a peer advertises differs from
 * its own.
 *
 * Free of I/O imports so the decision can be tested; the caller passes the
 * network and file access in.
 */

import { showPeerValue } from "./forkScheduleAgreement"

const SHA256_HEX = /^[0-9a-f]{64}$/

export type GenesisMismatchOutcome =
    | { outcome: "match" }
    /**
     * The hash this node trusts (its stored block 0, or the operator's pinned
     * hash) is the local file's own, so a peer that advertises another one is
     * wrong. The local file stays and nothing is downloaded.
     */
    | { outcome: "peer-disagrees"; peerAdvertisedHash: string }
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
    /**
     * Replaces the genesis file with `data` atomically, refusing (and leaving
     * the file as it was) when what was written does not hash, core-wise, to
     * `expectedCoreHash`.
     */
    writeGenesis: (data: unknown, expectedCoreHash: string) => void
    /** The hash peers advertise and compare: covers everything in the stored block. */
    hashFull: (data: unknown) => string
    /** The hash without `forks` and `properties.id`. */
    hashCore: (data: unknown) => string
}

/** What a node holds as the authority for the network's genesis, if anything. */
export interface GenesisAuthority {
    /** Full hash of the genesis data in this node's stored block 0 from before this boot. */
    storedHash?: string | null
    /** Full hash the operator pinned for a node that has no stored block 0; empty when none. */
    expectedHash?: string
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
 * What the peer serves must hash, in full, to what it advertised, but that only
 * shows the peer is consistent with itself, not that it is right. When the node
 * has an authority (its stored block 0, else a pinned hash) that is what
 * decides: a peer that disagrees with an authority the local file already
 * matches is ignored, and a peer that disagrees with it when the file does not
 * is refused. Without any authority the first peer's word is all there is.
 */
export async function resolveGenesisMismatch(
    ourFullHash: string,
    ourCoreHash: string,
    peerAdvertisedHash: string,
    deps: GenesisMismatchDeps,
    authority: GenesisAuthority = {},
): Promise<GenesisMismatchOutcome> {
    if (typeof peerAdvertisedHash !== "string" || !SHA256_HEX.test(peerAdvertisedHash)) {
        throw new Error(
            "Peer advertised a genesis hash that is not a sha256 hex string: " +
                showPeerValue(peerAdvertisedHash),
        )
    }

    // The authority is consulted before the peer's agreement counts for anything:
    // a file and a peer that agree with each other are still the wrong chain
    // when the authority says otherwise.
    const trusted = authority.storedHash || authority.expectedHash || null
    if (trusted === null) {
        if (peerAdvertisedHash === ourFullHash) return { outcome: "match" }
    } else {
        const source = authority.storedHash ? "this node's stored block 0" : "EXPECTED_GENESIS_HASH"
        if (ourFullHash === trusted) {
            if (peerAdvertisedHash === ourFullHash) return { outcome: "match" }
            return { outcome: "peer-disagrees", peerAdvertisedHash }
        }
        if (peerAdvertisedHash === ourFullHash) {
            throw new Error(
                `The local genesis file hashes to ${ourFullHash} but the trusted genesis hash is ${trusted} ` +
                    `(${source}); the peer agreeing with the file does not make it right`,
            )
        }
        if (peerAdvertisedHash !== trusted) {
            throw new Error(
                `Peer advertises genesis hash ${peerAdvertisedHash} but the trusted genesis hash is ${trusted} ` +
                    `(${source}); ` +
                    "refusing to take genesis data from it",
            )
        }
    }

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

    if (deps.hashCore(merged) !== servedCore) {
        throw new Error(
            "Genesis data merged from peer does not hash like what the peer served",
        )
    }
    deps.writeGenesis(merged, servedCore)
    return {
        outcome: "replaced",
        servedCoreHash: servedCore,
        writtenFullHash: deps.hashFull(merged),
        carriedOver,
    }
}

/**
 * After a verdict of "unhashed-fields-only" the local file is kept as it is,
 * which is right for a node whose stored block 0 is the network's. A node whose
 * database was wiped has just created its block 0 from that edited file, and
 * what it stores hashes differently from what its peers advertise, so it could
 * never sync. Only a block 0 created at this very boot has no authority older
 * than the file itself, so the caller passes its hash here for that case only;
 * a block 0 that predates the boot is the authority and is never second-guessed
 * from what a peer advertises.
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
