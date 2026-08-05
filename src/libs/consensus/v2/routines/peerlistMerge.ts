import PeerManager from "src/libs/peer/PeerManager"
import { getSharedState } from "src/utilities/sharedState"
import GCR from "src/libs/blockchain/gcr/gcr"
import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"
import type { Validators } from "src/model/entities/Validators"

export const MERGE_PEERLIST_MAX_ENTRIES_PER_PEER = 1000

const MAX_IDENTITY_LENGTH = 20000
const MAX_BLOCK_HASH_LENGTH = 256
const HEX_IDENTITY_REGEX = /^(0x)?[0-9a-f]+$/

/**
 * One shard member's claim about where a network peer sits on the chain.
 * Relayed claims are inclusion-only evidence: an observation can vouch a
 * peer INTO the merged peerlist (when it places the peer exactly at the
 * round's parent block), but can never remove a peer that first-hand
 * data supports — so a hostile member cannot suppress a validator by
 * claiming it is ahead or behind.
 */
export interface SyncObservation {
    identity: string
    block: number
    block_hash: string
}

/**
 * Explicit lexicographic comparator for identity strings. Behaviourally
 * identical to a bare `.sort()` on strings, but stated outright because
 * peerlist ordering is consensus-relevant and the default comparator's
 * implicit stringification is a Sonar CI gate failure.
 */
export function compareIdentities(a: string, b: string): number {
    if (a === b) return 0
    return a < b ? -1 : 1
}

let contributionsBlockRef: number | null = null
let contributions = new Map<string, SyncObservation[]>()

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetPeerlistMerge(): void {
    contributionsBlockRef = null
    contributions = new Map()
}

/**
 * Our own observations for the exchange: ourselves plus every known peer
 * whose gossiped sync state sits at our current tip, each carrying the
 * (block, block_hash) we observed. Pubkeys only — connection strings are
 * observer-dependent and must not enter consensus data.
 */
export function getLocalSyncObservations(): SyncObservation[] {
    const seen = new Set<string>([getSharedState.publicKeyHex])
    const observations: SyncObservation[] = [
        {
            identity: getSharedState.publicKeyHex,
            block: getSharedState.lastBlockNumber,
            block_hash: getSharedState.lastBlockHash,
        },
    ]

    for (const peer of PeerManager.getInstance().getPeers()) {
        if (
            peer.sync.block === getSharedState.lastBlockNumber &&
            peer.sync.block_hash === getSharedState.lastBlockHash &&
            !seen.has(peer.identity)
        ) {
            seen.add(peer.identity)
            observations.push({
                identity: peer.identity,
                block: peer.sync.block,
                block_hash: peer.sync.block_hash,
            })
        }
    }

    return observations.sort((a, b) => compareIdentities(a.identity, b.identity))
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

    // Cap BEFORE validating: lowercasing and regex-testing every element of
    // an attacker-supplied array first would let a hostile contributor push
    // unbounded work onto the consensus tick regardless of the cap. Slice to
    // the cap up front so validation cost is bounded by the cap, not by the
    // reported length.
    if (peerlist.length > MERGE_PEERLIST_MAX_ENTRIES_PER_PEER) {
        log.warning(
            `[peerlistMerge] Contributor ${contributor} reported ${peerlist.length} peers; ` +
                `capping at ${MERGE_PEERLIST_MAX_ENTRIES_PER_PEER} for this round`,
        )
    }

    const entries = peerlist
        .slice(0, MERGE_PEERLIST_MAX_ENTRIES_PER_PEER)
        .flatMap((entry): SyncObservation[] => {
            if (!entry || typeof entry !== "object") {
                return []
            }
            const { identity, block, block_hash } = entry as Record<
                string,
                unknown
            >
            if (
                typeof identity !== "string" ||
                identity.length === 0 ||
                identity.length > MAX_IDENTITY_LENGTH
            ) {
                return []
            }
            const normalized = identity.toLowerCase()
            if (!HEX_IDENTITY_REGEX.test(normalized)) {
                return []
            }
            if (
                typeof block !== "number" ||
                !Number.isInteger(block) ||
                block < 0
            ) {
                return []
            }
            if (
                typeof block_hash !== "string" ||
                block_hash.length === 0 ||
                block_hash.length > MAX_BLOCK_HASH_LENGTH
            ) {
                return []
            }
            return [{ identity: normalized, block, block_hash }]
        })

    contributions.set(contributor, entries)
}

/**
 * Union of our own observations and all contributions for the round,
 * where an observation only counts if it places its peer exactly at the
 * round's parent block (number AND hash, pinned from our chain rather
 * than the moving tip). Observations claiming any other position —
 * behind, ahead, or a different hash — are ignored: they can neither
 * include nor exclude. Result is filtered to active validators,
 * deduplicated and sorted ascending. Deterministic given the same set
 * of contributions.
 */
export async function computeMergedPeerlist(
    blockRef: number,
): Promise<string[]> {
    const parentNumber = blockRef - 1
    const parentBlock = await Chain.getBlockByNumber(parentNumber)
    const parentHash = parentBlock?.hash ?? null

    const isAtParent = (observation: SyncObservation) =>
        parentHash !== null &&
        observation.block === parentNumber &&
        observation.block_hash === parentHash

    const merged = new Set<string>([getSharedState.publicKeyHex])

    for (const observation of getLocalSyncObservations()) {
        if (isAtParent(observation)) {
            merged.add(observation.identity)
        }
    }

    if (contributionsBlockRef === blockRef) {
        for (const entries of contributions.values()) {
            for (const observation of entries) {
                if (isAtParent(observation)) {
                    merged.add(observation.identity)
                }
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
        return [...merged].sort(compareIdentities)
    }

    const validatorAddresses = new Set<string>(
        activeValidators
            .map(v => v.address)
            .filter((a): a is string => a !== null),
    )

    return [...merged].filter(id => validatorAddresses.has(id)).sort()
}
