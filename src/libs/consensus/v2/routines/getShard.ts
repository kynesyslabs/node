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
    return Math.floor((getSharedState.shardSize * 2) / 3) + 1
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
async function readActiveValidatorAddresses(
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
        assertValidatorsNotRequired(
            "no committed peerlist AND no active validators",
        )
        log.warning(
            "[getShard] SECURITY: no committed peerlist and no active validators; " +
                "falling back to local peer view. This is only acceptable on development networks.",
        )
        return localViewFallback()
    }

    const result = [...new Set(pool)].sort(compareIdentities)

    poolCache.set(lastBlockNumber, result)
    if (poolCache.size > POOL_CACHE_MAX_ENTRIES) {
        poolCache.delete(poolCache.keys().next().value)
    }

    return result
}

/**
 * Ensure every pinned identity that is an online-eligible candidate holds
 * a committee slot, mutating `shard` in place.
 *
 * A pin missing from the draw replaces the last non-pinned member, walking
 * backwards. Slot 0 is never displaced: the secretary is
 * `shard.members[0]`, so rotation stays with the seeded draw. A pin that
 * is offline, outside the eligible pool, or left without a replaceable
 * slot is skipped — pinning is best-effort and never blocks a round.
 * Deterministic given (seed, pool, online view): the same inputs the draw
 * itself uses.
 *
 * @returns A per-pin outcome summary for the debug log.
 */
export function pinShardIdentities(shard: Peer[], candidates: Peer[]): string {
    const pinnedSet = new Set(PINNED_SHARD_IDENTITIES)
    const shardIds = new Set(shard.map(p => p.identity.toLowerCase()))
    const outcomes: string[] = []

    let replaceIndex = shard.length - 1
    for (const pinned of PINNED_SHARD_IDENTITIES) {
        const label = pinned.slice(0, 10)
        if (shardIds.has(pinned)) {
            outcomes.push(`${label}=drawn`)
            continue
        }
        const candidate = candidates.find(
            p => p.identity.toLowerCase() === pinned,
        )
        if (!candidate) {
            outcomes.push(`${label}=absent`)
            continue
        }
        while (
            replaceIndex > 0 &&
            pinnedSet.has(shard[replaceIndex].identity.toLowerCase())
        ) {
            replaceIndex--
        }
        if (replaceIndex <= 0) {
            outcomes.push(`${label}=no-slot`)
            continue
        }
        shard[replaceIndex] = candidate
        shardIds.add(pinned)
        outcomes.push(`${label}=swapped`)
        replaceIndex--
    }

    return outcomes.join(",")
}

/**
 * Committee for the next block: the deterministic eligible pool at
 * `lastBlockNumber`, filtered to peers currently indexed in the
 * PeerManager online list (ourselves always included), drawn with
 * Alea(seed). Liveness-filtered and therefore view-dependent —
 * verifyBlock must validate signers against getEligiblePool, never
 * against this selection.
 */
export default async function getShard(
    seed: string,
    lastBlockNumber: number = undefined,
): Promise<Peer[]> {
    if (lastBlockNumber === undefined || lastBlockNumber === null) {
        lastBlockNumber = getSharedState.lastBlockNumber
    }

    const pool = await getEligiblePool(lastBlockNumber)
    const peerman = PeerManager.getInstance()

    const onlineByIdentity = new Map<string, Peer>()
    for (const peer of await peerman.getOnlinePeers()) {
        onlineByIdentity.set(peer.identity.toLowerCase(), peer)
    }

    const selfId = getSharedState.publicKeyHex
    const candidates: Peer[] = []
    for (const identity of pool) {
        if (identity === selfId) {
            candidates.push(peerman.getPeer(identity) ?? new Peer("", identity))
            continue
        }
        const online = onlineByIdentity.get(identity)
        if (online) {
            candidates.push(online)
        }
    }

    let committeeSize = getSharedState.shardSize
    if (candidates.length < committeeSize) {
        committeeSize = candidates.length
    }

    const deterministicRandomness = Alea(seed)
    const available = [...candidates]
    const shard: Peer[] = []

    for (let i = 0; i < committeeSize && available.length > 0; i++) {
        const index = Math.floor(deterministicRandomness() * available.length)
        shard.push(available[index])
        available.splice(index, 1)
    }

    const pinOutcome = pinShardIdentities(shard, candidates)

    log.debug(
        `[getShard] pool at block ${lastBlockNumber}: ${pool.length}; ` +
            `online candidates: ${candidates.length}; shard: ${shard.length}; ` +
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
