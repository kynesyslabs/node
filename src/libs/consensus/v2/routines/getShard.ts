import { PeerManager } from "src/libs/peer"
import { Peer } from "src/libs/peer"
import Alea from "alea"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

export default async function getShard(seed: string): Promise<Peer[]> {
    // ! we need to get the peers from the last 3 blocks too
    const allPeers = await PeerManager.getInstance().getOnlinePeers()
    const peers = allPeers.filter(
        peer =>
            peer.sync.status ||
            peer.sync.block - getSharedState.lastBlockNumber <= 1,
    )

    // Select up to 10 peers from the list using the seed as a source of randomness
    let maxShardSize = 10
    if (peers.length < 10) {
        maxShardSize = peers.length
    }
    console.log("[getShard] maxShardSize: ", maxShardSize)
    const shard: Peer[] = []
    log.custom("last_shard", "Shard seed is: " + seed)
    getSharedState.lastShardSeed = seed
    const random = Alea(seed)
    let availablePeers = [...peers]

    // REVIEW: sort available peers by .identity (which is a hex string)
    // before choosing the peers for a uniform sample across nodes
    availablePeers.sort((a, b) => a.identity.localeCompare(b.identity))
    log.debug("availablePeers: " + JSON.stringify(availablePeers, null, 2))
    // REVIEW: check if this is the right way to do it
    // NOTE Choosing the secretary by randomly ordering the list: the first one is the secretary
    for (let i = 0; i < maxShardSize && availablePeers.length > 0; i++) {
        const index = Math.floor(random() * availablePeers.length)
        shard.push(availablePeers[index])
        availablePeers.splice(index, 1)
    }
    // Setting the last shard
    getSharedState.lastShard = shard.map(peer => peer.identity)
    if (getSharedState.lastShard.length < 3) {
        log.warning(
            "There are less than 3 peers in the last shard: this could be a security issue",
        )
    }
    log.info(`Last shard: ${getSharedState.lastShard}`)
    log.custom(
        "last_shard",
        JSON.stringify(getSharedState.lastShard, null, 2),
        false,
        true,
    )
    return shard
}
