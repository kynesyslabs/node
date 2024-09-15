import { PeerManager } from "src/libs/peer"
import { Peer } from "src/libs/peer"
import Alea from "alea"
import sharedState from "src/utilities/sharedState"
import log from "src/utilities/logger"

export default async function getShard(seed: string): Promise<Peer[]> {
    // ! we need to get the peers from the last 3 blocks too
    const peers = await PeerManager.getInstance().getOnlinePeers()
    // Select up to 10 peers from the list using the seed as a source of randomness
    let maxShardSize = 10
    if (peers.length < 10) {
        maxShardSize = peers.length
    }
    console.log("[getShard] maxShardSize: ", maxShardSize)
    const shard: Peer[] = []
    const random = Alea(seed)
    const availablePeers = [...peers]
    // REVIEW: check if this is the right way to do it
    for (let i = 0; i < maxShardSize && availablePeers.length > 0; i++) {
        const index = Math.floor(random() * availablePeers.length)
        shard.push(availablePeers[index])
        availablePeers.splice(index, 1)
    }
    // Setting the last shard
    sharedState.getInstance().lastShard = shard.map((peer) => peer.identity)
    if (sharedState.getInstance().lastShard.length < 3) {
        log.warning("There are less than 3 peers in the last shard: this could be a security issue")
    }
    log.info(`Last shard: ${sharedState.getInstance().lastShard}`)
    return shard
}