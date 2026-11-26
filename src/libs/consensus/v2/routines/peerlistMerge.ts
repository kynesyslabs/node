import PeerManager from "src/libs/peer/PeerManager"
import { getSharedState } from "src/utilities/sharedState"
import GCR from "src/libs/blockchain/gcr/gcr"
import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"
import type { Validators } from "src/model/entities/Validators"
import { isForkActive } from "@/forks/forkGates"
import { quorumThreshold } from "../quorum"
import { compareIdentities } from "./poolRules"

export const MERGE_PEERLIST_MAX_ENTRIES_PER_PEER = 1000
/** Entries of one report that are read before the rest is ignored. */
export const MERGE_PEERLIST_MAX_EXAMINED_PER_PEER = 2000

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

export { compareIdentities }

let contributionsBlockRef: number | null = null
let contributions = new Map<string, SyncObservation[]>()
let snapshotBlockRef: number | null = null
let snapshot: SyncObservation[] | null = null

// The last non-empty staked set read, reused for every report of its height.
let stakedCache: { height: number; set: Set<string> } | null = null

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetPeerlistMerge(): void {
    stakedCache = null
    contributionsBlockRef = null
    contributions = new Map()
    snapshotBlockRef = null
    snapshot = null
}

/**
 * Takes our observation table for a round once, so every member receives
 * the same copy whether it reads our request or our response.
 */
export function freezeLocalSyncObservations(blockRef: number): void {
    snapshotBlockRef = blockRef
    snapshot = collectLocalSyncObservations()
}

/**
 * Our own observations for the exchange: the frozen snapshot for
 * `blockRef` when one exists, otherwise a live read. Only staked identities
 * are reported, so unstaked peers cannot fill a receiver's per-report cap.
 */
export async function getLocalSyncObservations(
    blockRef?: number,
): Promise<SyncObservation[]> {
    const table =
        blockRef !== undefined && blockRef === snapshotBlockRef && snapshot
            ? snapshot
            : collectLocalSyncObservations()
    let staked: Set<string> | null
    try {
        staked = await stakedAt(getSharedState.lastBlockNumber)
    } catch (error) {
        log.error(`[peerlistMerge] Validator read failed; reporting no peers: ${error}`)
        return []
    }
    if (!staked) return table
    return table.filter(o => staked.has(o.identity.toLowerCase()))
}

/**
 * The staked identities at `height`, the set computeMergedPeerlist filters
 * the merged list by. Null on a development network, where nothing is
 * filtered. Throws when the read fails.
 */
async function stakedAt(height: number): Promise<Set<string> | null> {
    if (stakedCache?.height === height) return stakedCache.set
    const validators = await GCR.getGCRValidatorsAtBlockOrThrow(height)
    if (validators.length === 0) return null
    const set = new Set(validators.map(v => v.address))
    stakedCache = { height, set }
    return set
}

/**
 * Ourselves plus every known peer whose gossiped sync state sits at our
 * current tip, each carrying the (block, block_hash) we observed. Pubkeys
 * only — connection strings are observer-dependent and must not enter
 * consensus data.
 */
function collectLocalSyncObservations(): SyncObservation[] {
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
 * than accumulate. Only staked identities are kept, up to the cap, however
 * many entries the report holds.
 */
export async function contributePeerlist(
    blockRef: unknown,
    contributor: string,
    peerlist: unknown,
): Promise<void> {
    if (typeof blockRef !== "number" || !Number.isInteger(blockRef)) {
        return
    }
    if (!contributor || !Array.isArray(peerlist)) {
        return
    }

    // A higher blockRef replaces the round's contributions and drops every
    // later one for it, so a peer naming a far height would empty the merge
    // until the chain got there. No round opens past our tip + 1. The round
    // we opened counts too: its blockRef comes from the stored chain, and
    // the shared tip trails a fresh insert until its commit completes.
    const tip = getSharedState.lastBlockNumber
    const ceiling = Math.max(tip + 1, snapshotBlockRef ?? -Infinity)
    if (!Number.isInteger(tip) || blockRef > ceiling) {
        log.warning(
            `[peerlistMerge] Ignoring ${contributor}'s peerlist for block ${blockRef}: past the round we can open (${ceiling})`,
        )
        return
    }

    // Read before touching the round's state, so nothing below awaits.
    let staked: Set<string> | null
    try {
        staked = await stakedAt(blockRef - 1)
    } catch (error) {
        log.error(
            `[peerlistMerge] Validator read failed; dropping ${contributor}'s peerlist for block ${blockRef}: ${error}`,
        )
        return
    }

    if (contributionsBlockRef !== blockRef) {
        if (contributionsBlockRef !== null && blockRef < contributionsBlockRef) {
            return
        }
        contributions = new Map()
        contributionsBlockRef = blockRef
    }

    // With a validator set, the first 2,000 entries are examined and the cap
    // counts staked ones only, so an unstaked entry takes no slot. Without
    // one, the report is cut to the cap before validating.
    const candidates = peerlist.slice(
        0,
        staked
            ? MERGE_PEERLIST_MAX_EXAMINED_PER_PEER
            : MERGE_PEERLIST_MAX_ENTRIES_PER_PEER,
    )
    const entries: SyncObservation[] = []
    for (const entry of candidates) {
        if (entries.length >= MERGE_PEERLIST_MAX_ENTRIES_PER_PEER) {
            log.warning(
                `[peerlistMerge] Contributor ${contributor} reported more than ` +
                    `${MERGE_PEERLIST_MAX_ENTRIES_PER_PEER} peers; capping for this round`,
            )
            break
        }
        if (!entry || typeof entry !== "object") continue
        const { identity, block, block_hash } = entry as Record<
            string,
            unknown
        >
        if (
            typeof identity !== "string" ||
            identity.length === 0 ||
            identity.length > MAX_IDENTITY_LENGTH
        ) {
            continue
        }
        const normalized = identity.toLowerCase()
        if (staked ? !staked.has(normalized) : !HEX_IDENTITY_REGEX.test(normalized)) {
            continue
        }
        if (typeof block !== "number" || !Number.isInteger(block) || block < 0) {
            continue
        }
        if (
            typeof block_hash !== "string" ||
            block_hash.length === 0 ||
            block_hash.length > MAX_BLOCK_HASH_LENGTH
        ) {
            continue
        }
        entries.push({ identity: normalized, block, block_hash })
    }

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
/**
 * Identities observed at the round's parent block by a quorum of the
 * shard. Each shard member is one voter: our own table is our vote, and a
 * contribution counts only when its contributor is a member. Absent
 * members still count towards the quorum; collectParentVotes says which
 * quorum applies.
 */
export async function computeMergedPeerlist(
    blockRef: number,
    shardMembers: string[],
): Promise<string[]> {
    const { votes, quorum } = await collectParentVotes(blockRef, shardMembers)

    const merged = new Set<string>()
    for (const [identity, seenBy] of votes) {
        if (seenBy.size >= quorum) {
            merged.add(identity)
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

/**
 * Who observed which identity at the round's parent block, one vote per
 * member of `shardMembers`: our own table is our vote, and a contribution
 * counts only when its contributor is a member.
 *
 * Before committeeBinding the members are the caller's shard and the
 * quorum is 2/3 + 1 of them, absent members included. Under it the
 * members must be the round's bound committee, and the quorum is the
 * block's signature bar, 2/3 + 1 of shardSize. Both are chain data, so
 * every node in the round holds an entry to the same bar; the live members
 * each node can reach differ between nodes and must not set it.
 */
async function collectParentVotes(
    blockRef: number,
    shardMembers: string[],
): Promise<{ votes: Map<string, Set<string>>; quorum: number }> {
    const parentNumber = blockRef - 1
    const parentBlock = await Chain.getBlockByNumber(parentNumber)
    const parentHash = parentBlock?.hash ?? null

    const isAtParent = (observation: SyncObservation) =>
        parentHash !== null &&
        observation.block === parentNumber &&
        observation.block_hash === parentHash

    const voters = new Set(shardMembers.map(m => m.toLowerCase()))
    const quorum = isForkActive("committeeBinding", blockRef)
        ? quorumThreshold(getSharedState.shardSize)
        : quorumThreshold(voters.size)
    const votes = new Map<string, Set<string>>()
    const vote = (voter: string, observation: SyncObservation) => {
        if (!isAtParent(observation)) return
        const identity = observation.identity.toLowerCase()
        let seenBy = votes.get(identity)
        if (!seenBy) {
            seenBy = new Set()
            votes.set(identity, seenBy)
        }
        seenBy.add(voter)
    }

    const ourKey = getSharedState.publicKeyHex.toLowerCase()
    if (voters.has(ourKey)) {
        for (const observation of await getLocalSyncObservations(blockRef)) {
            vote(ourKey, observation)
        }
    }

    if (contributionsBlockRef === blockRef) {
        for (const [contributor, entries] of contributions) {
            const voter = contributor.toLowerCase()
            if (!voters.has(voter)) continue
            for (const observation of entries) {
                vote(voter, observation)
            }
        }
    }

    return { votes, quorum }
}

/**
 * Checks a merged peerlist dictated by the secretary: well-formed, sorted,
 * unique, and staked at the round's parent height when a validator set
 * exists. With `shardMembers`, it is also held to our own contributions:
 * every entry must have been observed at the parent block by some member,
 * and every staked identity that reaches quorum in our view must be
 * present. The secretary can then neither invent a validator nor drop one
 * the shard agreed on.
 *
 * Under committeeBinding `shardMembers` is the round's bound committee, and
 * every entry must itself reach quorum in our view, the rule
 * computeMergedPeerlist applies. The list is the pool the next
 * committee is drawn from, so an identity below quorum would be an optional
 * entry: with k of them the secretary could pick among 2^k pools, hence
 * committees. Without them the list is fixed by the shard's observations.
 * Returns the list or null when it fails.
 */
export async function validateMergedPeerlist(
    blockRef: number,
    peerlist: unknown,
    shardMembers?: string[],
): Promise<string[] | null> {
    if (!Array.isArray(peerlist)) return null
    if (peerlist.length > MERGE_PEERLIST_MAX_ENTRIES_PER_PEER) return null

    for (const [index, entry] of peerlist.entries()) {
        if (
            typeof entry !== "string" ||
            entry.length === 0 ||
            entry.length > MAX_IDENTITY_LENGTH ||
            !HEX_IDENTITY_REGEX.test(entry) ||
            entry !== entry.toLowerCase()
        ) {
            return null
        }
        if (index > 0 && compareIdentities(peerlist[index - 1], entry) >= 0) {
            return null
        }
    }

    const list = peerlist as string[]

    // Same validator set the secretary filtered with, so an unstaked peer
    // the shard observed is neither required nor allowed.
    const activeValidators = (await GCR.getGCRValidatorsAtBlock(
        blockRef - 1,
    )) as Validators[]
    const validatorAddresses = new Set<string>(
        activeValidators
            .map(v => v.address)
            .filter((a): a is string => a !== null),
    )
    const isStaked = (id: string) =>
        activeValidators.length === 0 || validatorAddresses.has(id)

    if (shardMembers) {
        const { votes, quorum } = await collectParentVotes(blockRef, shardMembers)
        const listed = new Set(list)
        const invented = list.filter(id => !votes.has(id))
        if (invented.length > 0) {
            log.error(
                `[peerlistMerge] dictated peerlist for block ${blockRef} names ${invented.length} identit(ies) nobody observed at the parent block: ${invented.join(", ")}`,
            )
            return null
        }
        if (isForkActive("committeeBinding", blockRef)) {
            const belowQuorum = list.filter(
                id => (votes.get(id)?.size ?? 0) < quorum,
            )
            if (belowQuorum.length > 0) {
                log.error(
                    `[peerlistMerge] dictated peerlist for block ${blockRef} names ${belowQuorum.length} identit(ies) below quorum (${quorum}) in our view: ${belowQuorum.join(", ")}`,
                )
                return null
            }
        }
        const dropped = [...votes]
            .filter(
                ([id, seenBy]) =>
                    seenBy.size >= quorum && isStaked(id) && !listed.has(id),
            )
            .map(([id]) => id)
        if (dropped.length > 0) {
            log.error(
                `[peerlistMerge] dictated peerlist for block ${blockRef} omits ${dropped.length} staked identit(ies) at quorum in our view: ${dropped.join(", ")}`,
            )
            return null
        }
    }

    return list.every(isStaked) ? list : null
}
