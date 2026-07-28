import { PeerManager } from "src/libs/peer"
import { Peer } from "src/libs/peer"
import Alea from "alea"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import Chain from "src/libs/blockchain/chain"
import GCR from "src/libs/blockchain/gcr/gcr"
import type { Validators } from "src/model/entities/Validators"

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

    const committed: string[] = []
    if (lastBlockNumber >= 1) {
        const block = await Chain.getBlockByNumber(lastBlockNumber)
        const rawPeerlist = block?.content?.peerlist as unknown as unknown[]
        if (Array.isArray(rawPeerlist)) {
            for (const entry of rawPeerlist) {
                if (typeof entry === "string" && entry.length > 0) {
                    committed.push(entry.toLowerCase())
                }
            }
        }
    }

    const activeValidators = (await GCR.getGCRValidatorsAtBlock(
        lastBlockNumber,
    )) as Validators[]
    const validatorAddresses = new Set<string>(
        activeValidators
            .map(v => v.address)
            .filter((a): a is string => a !== null),
    )

    let pool: string[]
    if (committed.length > 0) {
        if (validatorAddresses.size > 0) {
            pool = committed.filter(id => validatorAddresses.has(id))
        } else {
            if (process.env.DEMOS_REQUIRE_VALIDATORS === "true") {
                throw new Error(
                    "[getShard] committed peerlist but no active validators AND DEMOS_REQUIRE_VALIDATORS=true; refusing to operate",
                )
            }
            log.warning(
                "[getShard] SECURITY: no active validators in DB; using committed peerlist unfiltered. " +
                    "This is only acceptable on development networks.",
            )
            pool = committed
        }
    } else if (validatorAddresses.size > 0) {
        log.info(
            `[getShard] Block ${lastBlockNumber} has no committed peerlist; bootstrapping pool from ${validatorAddresses.size} active validators`,
        )
        pool = [...validatorAddresses]
    } else {
        if (process.env.DEMOS_REQUIRE_VALIDATORS === "true") {
            throw new Error(
                "[getShard] no committed peerlist AND no active validators AND DEMOS_REQUIRE_VALIDATORS=true; refusing to operate",
            )
        }
        log.warning(
            "[getShard] SECURITY: no committed peerlist and no active validators; " +
                "falling back to local peer view. This is only acceptable on development networks.",
        )
        const localView = new Set<string>([getSharedState.publicKeyHex])
        for (const peer of PeerManager.getInstance().getPeers()) {
            if (
                peer.sync.block === getSharedState.lastBlockNumber &&
                peer.sync.block_hash === getSharedState.lastBlockHash
            ) {
                localView.add(peer.identity)
            }
        }
        return [...localView].sort()
    }

    const result = [...new Set(pool)].sort()

    poolCache.set(lastBlockNumber, result)
    if (poolCache.size > POOL_CACHE_MAX_ENTRIES) {
        poolCache.delete(poolCache.keys().next().value)
    }

    return result
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
            candidates.push(
                peerman.getPeer(identity) ?? new Peer("", identity),
            )
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

    log.debug(
        `[getShard] pool at block ${lastBlockNumber}: ${pool.length}; ` +
            `online candidates: ${candidates.length}; shard: ${shard.length}`,
    )

    if (shard.length < getCommitteeFloor()) {
        log.warning(
            `[getShard] Shard of ${shard.length} is below the floor of ${getCommitteeFloor()}: ` +
                "the network cannot forge until more validators are online",
        )
    }

    return shard
}
