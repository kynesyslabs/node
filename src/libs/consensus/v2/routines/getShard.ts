import { PeerManager } from "src/libs/peer"
import { Peer } from "src/libs/peer"
import Alea from "alea"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { getLastBlockSigners } from "@/libs/blockchain/chainBlocks"
import GCR from "src/libs/blockchain/gcr/gcr"
import type { Validators } from "src/model/entities/Validators"

// Per-block cache of the active-validator query. getShard runs on every
// consensus tick (multiple times per block), but the validator set only
// changes via stake/unstake/exit txs which land at block boundaries.
// Caching keyed by `lastBlockNumber` collapses N round-trips per block
// into one. Exported for tests via `__resetValidatorCache`.
let cachedBlock: number | null = null
let cachedValidators: Validators[] | null = null

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetValidatorCache(): void {
    cachedBlock = null
    cachedValidators = null
}

/**
 * Retrieve the current list of online peers, filtered to active validators.
 *
 * @param seed - Seed intended for deterministic shard selection; currently not used and has no effect
 * @returns An array of peers that are currently considered online and are active validators
 */
export default async function getShard(seed: string): Promise<Peer[]> {
    // ! we need to get the peers from the last 3 blocks too
    const peerman = PeerManager.getInstance()
    const allPeers = await peerman.getOnlinePeers()
    const peers = allPeers.filter(
        peer =>
            // peer.status.online &&
            // peer.sync.status &&
            peer.sync.block === getSharedState.lastBlockNumber &&
            peer.sync.block_hash === getSharedState.lastBlockHash,
    )

    const lastBlockSigners = await getLastBlockSigners()

    const initialPeers = new Set(peers.map(peer => peer.identity))
    for (const signer of lastBlockSigners) {
        const peer = peerman.getPeer(signer)

        if (peer && !initialPeers.has(signer)) {
            peers.push(peer)
        }
    }

    // Fetch active validators from DB at the current block, with a
    // per-block memoisation to avoid one DB round-trip per consensus tick.
    const lastBlock = getSharedState.lastBlockNumber
    let activeValidators: Validators[]
    if (cachedBlock === lastBlock && cachedValidators !== null) {
        activeValidators = cachedValidators
    } else {
        activeValidators = await GCR.getGCRValidatorsAtBlock(lastBlock) as Validators[]
        cachedBlock = lastBlock
        cachedValidators = activeValidators
    }

    let validatedPeers: Peer[]

    if (activeValidators.length === 0) {
        if (process.env.DEMOS_REQUIRE_VALIDATORS === "true") {
            throw new Error(
                "[getShard] no active validators in DB AND DEMOS_REQUIRE_VALIDATORS=true; refusing to operate",
            )
        }
        log.warning(
            "[getShard] SECURITY: no active validators in DB; falling back to online-peer-only shard selection. Set DEMOS_REQUIRE_VALIDATORS=true to enforce.",
        )
        validatedPeers = peers
    } else {
        // Validators.address is typed `string | null` (PrimaryColumn but
        // TypeORM widens to null); filter defensively so a NULL row can't
        // accidentally land in the set as a string and corrupt the filter.
        const validatorAddressSet = new Set<string>(
            activeValidators
                .map(v => v.address)
                .filter((a): a is string => a !== null),
        )
        validatedPeers = peers.filter(peer =>
            validatorAddressSet.has(peer.identity),
        )
    }

    // Select up to 10 peers from the list using the seed as a source of randomness
    let maxShardSize = getSharedState.shardSize
    if (validatedPeers.length < maxShardSize) {
        maxShardSize = validatedPeers.length
    }
    log.debug(`[getShard] maxShardSize: ${maxShardSize}`)
    const shard: Peer[] = []
    log.custom("last_shard", "Shard seed is: " + seed)
    // getSharedState.lastShardSeed = seed
    const deterministicRandomness = Alea(seed)
    const availablePeers = [...validatedPeers]

    // REVIEW: sort available peers by .identity (which is a hex string)
    // before choosing the peers for a uniform sample across nodes
    availablePeers.sort((a, b) => a.identity.localeCompare(b.identity))
    // REVIEW: check if this is the right way to do it
    // NOTE Choosing the secretary by randomly ordering the list: the first one is the secretary
    for (let i = 0; i < maxShardSize && availablePeers.length > 0; i++) {
        const index = Math.floor(
            deterministicRandomness() * availablePeers.length,
        )
        shard.push(availablePeers[index])
        availablePeers.splice(index, 1)
    }

    log.info(
        `[getShard] active validators in DB: ${activeValidators.length}; online+validator peers: ${validatedPeers.length}; shard size: ${shard.length}`,
    )

    // Setting the last shard
    // getSharedState.lastShard = shard.map(peer => peer.identity)
    if (shard.length < 3) {
        log.warning(
            "There are less than 3 peers in the last shard: this could be a security issue",
        )
    }

    log.custom(
        "last_shard",
        JSON.stringify(
            shard.map(peer => peer.identity),
            null,
            2,
        ),
        false,
        true,
    )
    return shard
}
