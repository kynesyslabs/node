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
 * - if the committed peerlist is empty (genesis, bootstrap), the full
 *   active validator set at that block;
 * - if there are no validators either, a local-view fallback for bare
 *   development networks (view-dependent, guarded by
 *   DEMOS_REQUIRE_VALIDATORS).
 *
 * Deduplicated and sorted ascending, so every synced node computes the
 * identical pool.
 */
async function getEligiblePool(lastBlockNumber: number): Promise<string[]> {
    if (poolCache.has(lastBlockNumber)) {
        return poolCache.get(lastBlockNumber)
    }

    const committed: string[] = []
    if (lastBlockNumber >= 0) {
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
            log.warning(
                "[getShard] SECURITY: no active validators in DB; using committed peerlist unfiltered",
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
        pool = [...localView]
    }

    const result = [...new Set(pool)].sort()

    poolCache.set(lastBlockNumber, result)
    if (poolCache.size > POOL_CACHE_MAX_ENTRIES) {
        poolCache.delete(poolCache.keys().next().value)
    }

    return result
}

/**
 * Deterministically selects the committee for the block after
 * `lastBlockNumber`. Pure function of the seed and on-chain state at
 * that block — no liveness checks, no local peer view. This is the
 * only selection function verifyBlock may use.
 */
export async function getShardIdentities(
    seed: string,
    lastBlockNumber: number,
): Promise<string[]> {
    const pool = await getEligiblePool(lastBlockNumber)

    let committeeSize = getSharedState.shardSize
    if (pool.length < committeeSize) {
        committeeSize = pool.length
    }

    const deterministicRandomness = Alea(seed)
    const availableIdentities = [...pool]
    const committee: string[] = []

    for (let i = 0; i < committeeSize && availableIdentities.length > 0; i++) {
        const index = Math.floor(
            deterministicRandomness() * availableIdentities.length,
        )
        committee.push(availableIdentities[index])
        availableIdentities.splice(index, 1)
    }

    log.debug(
        `[getShard] pool at block ${lastBlockNumber}: ${pool.length}; committee: ${committee.length}`,
    )

    if (committee.length < getCommitteeFloor()) {
        log.warning(
            `[getShard] Committee of ${committee.length} is below the floor of ${getCommitteeFloor()}: ` +
                "the network cannot forge until more validators are online",
        )
    }

    return committee
}

/**
 * Committee for the next block, resolved to Peer objects for the
 * consensus networking paths. Identities unknown to the local
 * PeerManager are resolved through the validator table's
 * connection_url, and become placeholder peers with an empty
 * connection string as a last resort rather than being dropped —
 * shard membership must not depend on the local peer table.
 * Resolved fallbacks and placeholders are never added to the
 * PeerManager.
 */
export default async function getShard(
    seed: string,
    lastBlockNumber: number = undefined,
): Promise<Peer[]> {
    if (lastBlockNumber === undefined || lastBlockNumber === null) {
        lastBlockNumber = getSharedState.lastBlockNumber
    }

    const identities = await getShardIdentities(seed, lastBlockNumber)
    const peerman = PeerManager.getInstance()

    let validatorUrls: Map<string, string> | null = null
    const getValidatorUrl = async (identity: string): Promise<string> => {
        if (!validatorUrls) {
            const validators = (await GCR.getGCRValidatorsAtBlock(
                lastBlockNumber,
            )) as Validators[]
            validatorUrls = new Map()
            for (const validator of validators) {
                if (validator.address && validator.connection_url) {
                    validatorUrls.set(
                        validator.address,
                        validator.connection_url,
                    )
                }
            }
        }
        return validatorUrls.get(identity) ?? ""
    }

    const shard: Peer[] = []
    for (const identity of identities) {
        const known = peerman.getPeer(identity)
        if (known) {
            shard.push(known)
            continue
        }
        const fallbackUrl = await getValidatorUrl(identity)
        if (fallbackUrl) {
            log.debug(
                `[getShard] Resolved ${identity} via validator connection_url: ${fallbackUrl}`,
            )
        }
        shard.push(new Peer(fallbackUrl, identity))
    }

    return shard
}
