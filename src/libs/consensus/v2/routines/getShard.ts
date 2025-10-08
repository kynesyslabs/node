import { PeerManager } from "src/libs/peer"
import { Peer } from "src/libs/peer"
import Alea from "alea"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import Chain from "src/libs/blockchain/chain"

export default async function getShard(seed: string): Promise<Peer[]> {
    // ! we need to get the peers from the last 3 blocks too
    const allPeers = await PeerManager.getInstance().getOnlinePeers()
    const peers = allPeers.filter(peer => peer.sync.status)

    // const peerIdentites = peers.map(peer => peer.identity)

    // const lastBlock = await Chain.getLastBlock()

    // log.debug(
    //     "typeof lastBlock.validation_data: " + typeof lastBlock.validation_data,
    // )
    // log.debug(`Last block: ${lastBlock.validation_data}`)

    // let signatures: { [key: string]: string } = {}

    // if (lastBlock.validation_data !== "genesis") {
    //     signatures = JSON.parse(lastBlock.validation_data)["signatures"]
    // }

    // // INFO: Include the validators from the last block
    // // REVIEW: Do we include all peers from the last N blocks or only the validators?
    // for (const identity of Object.keys(signatures)) {
    //     if (peerIdentites.includes(identity)) {
    //         continue
    //     }

    //     const peer = PeerManager.getInstance().getPeer(identity)
    //     log.debug(
    //         `Peer result for ${identity}: ${JSON.stringify(peer, null, 2)}`,
    //     )

    //     if (peer) {
    //         log.debug(`Peer ${identity} not in the shard, adding it`)
    //         peers.push(peer)
    //     }
    // }

    // Select up to 10 peers from the list using the seed as a source of randomness
    let maxShardSize = getSharedState.shardSize
    if (peers.length < maxShardSize) {
        maxShardSize = peers.length
    }
    console.log("[getShard] maxShardSize: ", maxShardSize)
    const shard: Peer[] = []
    log.custom("last_shard", "Shard seed is: " + seed)
    getSharedState.lastShardSeed = seed
    const random = Alea(seed)
    const availablePeers = [...peers]

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
