import { PeerManager } from "src/libs/peer"
import { Peer } from "src/libs/peer"
import Alea from "alea"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import Chain from "src/libs/blockchain/chain"
import GCR from "src/libs/blockchain/gcr/gcr"
import type { Validators } from "src/model/entities/Validators"
import { compareIdentities } from "./peerlistMerge"
import { PINNED_SHARD_IDENTITIES } from "src/utilities/constants"
import { quorumThreshold } from "../quorum"
import { isForkActive } from "@/forks/forkGates"
import getCommonValidatorSeed from "./getCommonValidatorSeed"

// The eligible pool is a pure function of on-chain state at a given
// block, so it is memoised per block number. Sync verification walks
// blocks sequentially while consensus reads the tip, hence a small
// multi-entry cache instead of a single slot.
const POOL_CACHE_MAX_ENTRIES = 8
const poolCache = new Map<number, string[]>()

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetValidatorCache(): void {
    poolCache.clear()
}

/**
 * Minimum committee size below which the network does not forge or
 * accept blocks. Equal to the quorum a full-size shard would need, so
 * a committee that cannot possibly meet quorum never forms at all.
 */
export function getCommitteeFloor(): number {
    return quorumThreshold(getSharedState.shardSize)
}

/** Identities committed in a block's peerlist, normalised to lowercase. */
async function readCommittedPeerlist(
    lastBlockNumber: number,
): Promise<string[]> {
    if (lastBlockNumber < 1) {
        return []
    }

    const committed: string[] = []
    const block = await Chain.getBlockByNumber(lastBlockNumber)
    const rawPeerlist = block?.content?.peerlist as unknown as unknown[]
    if (Array.isArray(rawPeerlist)) {
        for (const entry of rawPeerlist) {
            if (typeof entry === "string" && entry.length > 0) {
                committed.push(entry.toLowerCase())
            }
        }
    }
    return committed
}

/** Addresses of the active (staked) validator set at a block. */
export async function readActiveValidatorAddresses(
    lastBlockNumber: number,
): Promise<Set<string>> {
    const activeValidators = (await GCR.getGCRValidatorsAtBlock(
        lastBlockNumber,
    )) as Validators[]
    return new Set<string>(
        activeValidators
            .map(v => v.address)
            .filter((a): a is string => a !== null),
    )
}

/**
 * Last-resort pool for bare development networks: peers synced to our tip,
 * plus ourselves. View-dependent, so it is never memoised.
 */
function localViewFallback(): string[] {
    const localView = new Set<string>([getSharedState.publicKeyHex])
    for (const peer of PeerManager.getInstance().getPeers()) {
        if (
            peer.sync.block === getSharedState.lastBlockNumber &&
            peer.sync.block_hash === getSharedState.lastBlockHash
        ) {
            localView.add(peer.identity)
        }
    }
    return [...localView].sort(compareIdentities)
}

/** Throw when strict mode forbids operating without an active validator set. */
function assertValidatorsNotRequired(reason: string): void {
    if (process.env.DEMOS_REQUIRE_VALIDATORS === "true") {
        throw new Error(
            `[getShard] ${reason} AND DEMOS_REQUIRE_VALIDATORS=true; refusing to operate`,
        )
    }
}

/**
 * The eligible validator pool at a given block:
 * - the peerlist committed in that block (validators seen online by the
 *   shard that forged it), intersected with the active validator set;
 * - at block 0 (genesis commits no peerlist), or if the committed
 *   peerlist is empty (bootstrap), the full staked validator set at
 *   that block;
 * - if there are no validators either, a local-view fallback for bare
 *   development networks (view-dependent, guarded by
 *   DEMOS_REQUIRE_VALIDATORS, never memoised).
 *
 * Deduplicated and sorted ascending, so every synced node computes the
 * identical pool.
 */
export async function getEligiblePool(
    lastBlockNumber: number,
): Promise<string[]> {
    const pool = await chainEligiblePool(lastBlockNumber)
    if (pool !== null) {
        return pool
    }
    assertValidatorsNotRequired(
        "no committed peerlist AND no active validators",
    )
    log.warning(
        "[getShard] SECURITY: no committed peerlist and no active validators; " +
            "falling back to local peer view. This is only acceptable on development networks.",
    )
    return localViewFallback()
}

/**
 * The eligible pool as far as chain data defines it, or null when the
 * block commits no peerlist and there are no active validators, the case
 * getEligiblePool answers from the local peer view.
 */
async function chainEligiblePool(
    lastBlockNumber: number,
): Promise<string[] | null> {
    if (poolCache.has(lastBlockNumber)) {
        return poolCache.get(lastBlockNumber)
    }

    const committed = await readCommittedPeerlist(lastBlockNumber)
    const validatorAddresses =
        await readActiveValidatorAddresses(lastBlockNumber)

    let pool: string[]
    if (committed.length > 0 && validatorAddresses.size > 0) {
        pool = committed.filter(id => validatorAddresses.has(id))
    } else if (committed.length > 0) {
        assertValidatorsNotRequired(
            "committed peerlist but no active validators",
        )
        log.warning(
            "[getShard] SECURITY: no active validators in DB; using committed peerlist unfiltered. " +
                "This is only acceptable on development networks.",
        )
        pool = committed
    } else if (validatorAddresses.size > 0) {
        log.info(
            `[getShard] Block ${lastBlockNumber} has no committed peerlist; bootstrapping pool from ${validatorAddresses.size} active validators`,
        )
        pool = [...validatorAddresses]
    } else {
        return null
    }

    const result = [...new Set(pool)].sort(compareIdentities)

    poolCache.set(lastBlockNumber, result)
    if (poolCache.size > POOL_CACHE_MAX_ENTRIES) {
        poolCache.delete(poolCache.keys().next().value)
    }

    return result
}

/**
 * Move every pinned identity that is an online-eligible candidate to the
 * front of the committee, in `PINNED_SHARD_IDENTITIES` order, mutating
 * `shard` in place.
 *
 * The result is deterministic given the seed, the pool and the online view.
 *
 * @returns A per-pin outcome summary for the debug log.
 */
export function pinShardIdentities(shard: Peer[], candidates: Peer[]): string {
    const size = shard.length
    const drawnIds = new Set(shard.map(p => p.identity.toLowerCase()))
    const outcomes: string[] = []

    const front: Peer[] = []
    for (const pinned of PINNED_SHARD_IDENTITIES) {
        const label = pinned.slice(0, 10)
        const candidate = candidates.find(
            p => p.identity.toLowerCase() === pinned,
        )
        if (!candidate) {
            outcomes.push(`${label}=absent`)
            continue
        }
        if (front.length >= size) {
            outcomes.push(`${label}=no-slot`)
            continue
        }
        front.push(candidate)
        outcomes.push(`${label}=${drawnIds.has(pinned) ? "drawn" : "swapped"}`)
    }

    if (front.length === 0) {
        return outcomes.join(",")
    }

    const frontIds = new Set(front.map(p => p.identity.toLowerCase()))
    const rest = shard.filter(p => !frontIds.has(p.identity.toLowerCase()))
    shard.splice(0, shard.length, ...front, ...rest.slice(0, size - front.length))

    return outcomes.join(",")
}

/**
 * Deterministic permutation of the pool under `seed`. Ranking the full
 * pool before the live filter keeps a one-peer view difference to a
 * one-slot difference in the committee.
 */
export function rankPool(seed: string, pool: string[]): string[] {
    const deterministicRandomness = Alea(seed)
    const available = [...pool]
    const ranked: string[] = []
    while (available.length > 0) {
        const index = Math.floor(deterministicRandomness() * available.length)
        ranked.push(available[index])
        available.splice(index, 1)
    }
    return ranked
}

/**
 * Pool the bound committee is drawn from at `parentNumber`: the eligible
 * pool, or, when it holds fewer identities than a quorum, the whole staked
 * validator set at that block. A parent whose committed peerlist shrank
 * below the quorum would otherwise stop the chain for good, since staked
 * validators outside that peerlist could never be drawn. Both sources are
 * chain data, so every node falls back at the same height. Empty when the
 * chain defines no pool at all; the local-view fallback never applies.
 */
export async function getBoundPool(parentNumber: number): Promise<string[]> {
    const pool = await chainEligiblePool(parentNumber)
    if (pool === null) {
        // The local peer view differs between nodes, so a committee drawn
        // from it would not be chain data: no committee at all instead.
        log.error(
            `[getShard] Block ${parentNumber} commits no peerlist and there are no active validators: ` +
                "no bound committee can be drawn from chain data",
        )
        return []
    }
    if (pool.length >= getCommitteeFloor()) {
        return pool
    }

    const staked = await readActiveValidatorAddresses(parentNumber)
    if (staked.size <= pool.length) {
        return pool
    }
    log.warning(
        `[getShard] Eligible pool at block ${parentNumber} holds ${pool.length}, below the quorum of ` +
            `${getCommitteeFloor()}: drawing the committee from all ${staked.size} staked validators`,
    )
    return [...staked].sort(compareIdentities)
}

/**
 * Ranked pool with every pinned identity it contains moved to the front in
 * `PINNED_SHARD_IDENTITIES` order. Unlike `pinShardIdentities` it ignores
 * who is online, so the result depends on chain data only.
 */
export function pinRankedPool(ranked: string[]): string[] {
    const byLowercase = new Map(ranked.map(id => [id.toLowerCase(), id]))
    const front: string[] = []
    for (const pinned of PINNED_SHARD_IDENTITIES) {
        const id = byLowercase.get(pinned)
        if (id !== undefined && !front.includes(id)) front.push(id)
    }
    if (front.length === 0) return ranked
    return [...front, ...ranked.filter(id => !front.includes(id))]
}

/** The first `shardSize` identities of the pinned ranking of `pool` under `seed`. */
export function drawBoundCommittee(
    seed: string,
    pool: string[],
    shardSize: number,
): string[] {
    return pinRankedPool(rankPool(seed, pool)).slice(0, shardSize)
}

/**
 * Committee for block `parentNumber + 1` once `committeeBinding` applies:
 * a function of the chain up to the parent alone, so the producer, its
 * peers and a node syncing the block years later compute the same members.
 * Members that are offline stay in it and count as missing votes.
 *
 * `seed` is the common validator seed of the parent; when omitted it is
 * derived from the stored parent block, which is how sync obtains it.
 */
export async function getBoundCommittee(
    parentNumber: number,
    seed?: string,
): Promise<string[]> {
    if (seed === undefined) {
        const parent = await Chain.getBlockByNumber(parentNumber)
        if (!parent) {
            throw new Error(`block ${parentNumber} not found`)
        }
        seed = (await getCommonValidatorSeed(parent)).commonValidatorSeed
    }
    const pool = await getBoundPool(parentNumber)
    return drawBoundCommittee(seed, pool, getSharedState.shardSize)
}

/**
 * Committee for the next block: the deterministic eligible pool at
 * `lastBlockNumber` ranked with Alea(seed), then filtered to peers
 * currently indexed in the PeerManager online list (ourselves always
 * included), taking the first shardSize survivors. Liveness-filtered and
 * therefore view-dependent, so before committeeBinding verifyBlock
 * validates signers against getEligiblePool, never against this selection.
 *
 * Once `committeeBinding` applies to the next block, it returns the live
 * members of the bound committee instead, and verifyBlock counts only that
 * committee's signatures. An offline member is not replaced, so every
 * node's selection is a subset of the same committee. A caller that
 * already holds the committee for this (seed, block) passes it as
 * `committee`, so the live members come from the very list it tallies
 * votes against.
 */
export default async function getShard(
    seed: string,
    lastBlockNumber: number = undefined,
    committee?: string[],
): Promise<Peer[]> {
    if (lastBlockNumber === undefined || lastBlockNumber === null) {
        lastBlockNumber = getSharedState.lastBlockNumber
    }

    const bound = isForkActive("committeeBinding", lastBlockNumber + 1)
    if (bound && committee === undefined) {
        committee = await getBoundCommittee(lastBlockNumber, seed)
    }
    const pool = bound ? committee : await getEligiblePool(lastBlockNumber)
    const peerman = PeerManager.getInstance()

    const onlineByIdentity = new Map<string, Peer>()
    for (const peer of await peerman.getOnlinePeers()) {
        onlineByIdentity.set(peer.identity.toLowerCase(), peer)
    }

    const selfId = getSharedState.publicKeyHex
    const liveByIdentity = new Map<string, Peer>()
    let behind = 0
    for (const identity of pool) {
        if (identity === selfId) {
            liveByIdentity.set(
                identity,
                peerman.getPeer(identity) ?? new Peer("", identity),
            )
            continue
        }
        const online = onlineByIdentity.get(identity)
        if (!online) continue
        // A peer more than one block behind the tip cannot validate the
        // next block. One block behind is usually a status report in flight.
        const knownHeight = Math.max(
            online.sync?.block ?? 0,
            online.gossip?.height ?? 0,
        )
        if (knownHeight < lastBlockNumber - 1) {
            behind++
            continue
        }
        liveByIdentity.set(identity, online)
    }
    const candidates = [...liveByIdentity.values()]

    if (bound) {
        return liveBoundMembers(committee, lastBlockNumber, liveByIdentity)
    }

    const shard = rankPool(seed, pool)
        .filter(identity => liveByIdentity.has(identity))
        .slice(0, getSharedState.shardSize)
        .map(identity => liveByIdentity.get(identity))

    const pinOutcome = pinShardIdentities(shard, candidates)

    log.debug(
        `[getShard] pool at block ${lastBlockNumber}: ${pool.length}; ` +
            `online candidates: ${candidates.length} (${behind} behind the tip); shard: ${shard.length}; ` +
            `pins: ${pinOutcome}`,
    )

    if (shard.length < getCommitteeFloor()) {
        log.warning(
            `[getShard] Shard of ${shard.length} is below the floor of ${getCommitteeFloor()}: ` +
                "the network cannot forge until more validators are online",
        )
    }

    log.debug(
        "Shard members:",
        JSON.stringify(
            shard.map(m => m.connection.string),
            null,
            2,
        ),
    )
    return shard
}

function liveBoundMembers(
    committee: string[],
    lastBlockNumber: number,
    liveByIdentity: Map<string, Peer>,
): Peer[] {
    const shard = committee
        .filter(identity => liveByIdentity.has(identity))
        .map(identity => liveByIdentity.get(identity))

    log.debug(
        `[getShard] bound committee for block ${lastBlockNumber + 1}: ${committee.length}; ` +
            `live members: ${shard.length}`,
    )

    if (shard.length < getCommitteeFloor()) {
        // Every retry at this height draws the same committee, so operators
        // recover by bringing these members back; name them.
        const offline = committee.filter(identity => !liveByIdentity.has(identity))
        log.warning(
            `[getShard] ${shard.length} of the ${committee.length} bound committee members for block ` +
                `${lastBlockNumber + 1} are live, below the quorum of ${getCommitteeFloor()}: ` +
                `the block cannot be forged until more of them are online. Offline: ${offline.join(", ")}`,
        )
    }
    return shard
}
