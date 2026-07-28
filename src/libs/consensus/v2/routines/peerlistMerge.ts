import PeerManager from "src/libs/peer/PeerManager"
import { getSharedState } from "src/utilities/sharedState"
import GCR from "src/libs/blockchain/gcr/gcr"
import log from "src/utilities/logger"
import type { Validators } from "src/model/entities/Validators"

export const MERGE_PEERLIST_MAX_ENTRIES_PER_PEER = 1000

const MAX_IDENTITY_LENGTH = 20000
const HEX_IDENTITY_REGEX = /^(0x)?[0-9a-f]+$/

let contributionsBlockRef: number | null = null
let contributions = new Map<string, string[]>()

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetPeerlistMerge(): void {
    contributionsBlockRef = null
    contributions = new Map()
}

/**
 * Our own view of the peerlist: identities of known peers that are synced
 * to our current tip, plus our own identity. Pubkeys only — connection
 * strings are observer-dependent and must not enter consensus data.
 */
export function getLocalPeerlistView(): string[] {
    const view = new Set<string>()
    view.add(getSharedState.publicKeyHex)

    for (const peer of PeerManager.getInstance().getPeers()) {
        if (
            peer.sync.block === getSharedState.lastBlockNumber &&
            peer.sync.block_hash === getSharedState.lastBlockHash
        ) {
            view.add(peer.identity)
        }
    }

    return [...view].sort()
}

/**
 * Records a shard member's reported peerlist for a consensus round.
 * Contributions are keyed by contributor, so re-reports replace rather
 * than accumulate. Entries are validated and capped per contributor.
 */
export function contributePeerlist(
    blockRef: unknown,
    contributor: string,
    peerlist: unknown,
): void {
    if (typeof blockRef !== "number" || !Number.isInteger(blockRef)) {
        return
    }
    if (!contributor || !Array.isArray(peerlist)) {
        return
    }

    if (contributionsBlockRef !== blockRef) {
        if (contributionsBlockRef !== null && blockRef < contributionsBlockRef) {
            return
        }
        contributions = new Map()
        contributionsBlockRef = blockRef
    }

    let entries = peerlist
        .filter(
            (entry): entry is string =>
                typeof entry === "string" &&
                entry.length > 0 &&
                entry.length <= MAX_IDENTITY_LENGTH,
        )
        .map(entry => entry.toLowerCase())
        .filter(entry => HEX_IDENTITY_REGEX.test(entry))

    if (entries.length > MERGE_PEERLIST_MAX_ENTRIES_PER_PEER) {
        log.warning(
            `[peerlistMerge] Contributor ${contributor} reported ${entries.length} peers; ` +
                `capping at ${MERGE_PEERLIST_MAX_ENTRIES_PER_PEER} for this round`,
        )
        entries = entries.slice(0, MERGE_PEERLIST_MAX_ENTRIES_PER_PEER)
    }

    contributions.set(contributor, entries)
}

/**
 * Union of all contributions for the round and our own local view,
 * filtered to active validators, deduplicated and sorted ascending.
 * Deterministic given the same set of contributions.
 */
export async function computeMergedPeerlist(
    blockRef: number,
): Promise<string[]> {
    const merged = new Set<string>(getLocalPeerlistView())

    if (contributionsBlockRef === blockRef) {
        for (const entries of contributions.values()) {
            for (const entry of entries) {
                merged.add(entry)
            }
        }
    }

    // Filter against the validator set at the round's own parent height,
    // not the live tip: blockRef is lastBlockNumber + 1 when the round
    // opens, but the tip can advance mid-round via sync. Reading the
    // moving tip would let two nodes in the same round filter against
    // different heights and commit divergent block.content.peerlist
    // values, which then feeds committee selection.
    const activeValidators = (await GCR.getGCRValidatorsAtBlock(
        blockRef - 1,
    )) as Validators[]

    if (activeValidators.length === 0) {
        // Contributions are only shape-validated, so an unfiltered commit
        // lets any online identity reach block.content.peerlist and, via
        // getEligiblePool, subsequent shard selection without a stake.
        // Tolerated only for bootstrap/dev networks, where there is no
        // validator set to filter against yet.
        if (process.env.DEMOS_REQUIRE_VALIDATORS === "true") {
            throw new Error(
                "[peerlistMerge] no active validators AND DEMOS_REQUIRE_VALIDATORS=true; refusing to commit an unfiltered peerlist",
            )
        }
        log.warning(
            "[peerlistMerge] SECURITY: no active validators in DB; committing unfiltered peerlist. " +
                "This is only acceptable on development networks.",
        )
        return [...merged].sort()
    }

    const validatorAddresses = new Set<string>(
        activeValidators
            .map(v => v.address)
            .filter((a): a is string => a !== null),
    )

    return [...merged].filter(id => validatorAddresses.has(id)).sort()
}
