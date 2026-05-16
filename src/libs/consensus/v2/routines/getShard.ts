import { PeerManager } from "src/libs/peer"
import { Peer } from "src/libs/peer"
import Alea from "alea"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

/**
 * Retrieve the current list of online peers.
 *
 * @param seed - Seed intended for deterministic shard selection; currently not used and has no effect
 * @returns An array of peers that are currently considered online
 */
export default async function getShard(seed: string): Promise<Peer[]> {
    // ! we need to get the peers from the last 3 blocks too
    const allPeers = await PeerManager.getInstance().getOnlinePeers()
    const peers = allPeers.filter(
        peer =>
            // peer.status.online &&
            // peer.sync.status &&
            peer.sync.block === getSharedState.lastBlockNumber &&
            peer.sync.block_hash === getSharedState.lastBlockHash,
    )

    // Select up to 10 peers from the list using the seed as a source of randomness
    let maxShardSize = getSharedState.shardSize
    if (peers.length < maxShardSize) {
        maxShardSize = peers.length
    }
    log.debug(`[getShard] maxShardSize: ${maxShardSize}`)
    const shard: Peer[] = []
    log.custom("last_shard", "Shard seed is: " + seed)
    // getSharedState.lastShardSeed = seed
    const deterministicRandomness = Alea(seed)
    const availablePeers = [...peers]

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

    // Setting the last shard
    // getSharedState.lastShard = shard.map(peer => peer.identity)
    if (shard.length < 3) {
        log.warning(
            "There are less than 3 peers in the last shard: this could be a security issue",
        )
    }
    log.info(`Last shard: ${shard.map(peer => peer.identity)}`)
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
