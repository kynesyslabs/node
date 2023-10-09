// INFO The main loop executed in background by index.ts
import sharedState from "./sharedState"
import * as consensusTime from "../libs/consensus/routines/consensusTime"
import Sync from "src/libs/blockchain/routines/Sync"
import { Identity } from "src/libs/identity"

import { PeerManager } from "src/libs/peer"
import Chain from "src/libs/blockchain/chain"

async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

export default async function mainLoop(id: Identity) {
    console.log("[MAIN LOOP] Started")
    var cycleTimestamp: number
    while (sharedState.getInstance().runMainLoop) {
        await sleep(500) // Sleep for 1 second
        if (sharedState.getInstance().mainLoopPaused) {
            continue // Check if the main loop is paused
        }
        // NOTE Syncing the blockchain
        await Sync(id)
        // NOTE Using this as the timestamp of the current cycle
        // eslint-disable-next-line no-unused-vars
        cycleTimestamp = sharedState.getInstance().getTimestamp() // REVIEW Unused
        // NOTE The following routine is capable of checking if the consensus time has been reached automatically with a 100 ms blocking period

        // SECTION Todo list for a typical consensus operation

        // TODO Check if we have to forge the block now
        let isConsensusTimeReached = await consensusTime.checkConsensusTime()

        // every block write online list
        const peerManager = PeerManager.getInstance()
        const onlinePeers = peerManager.getOnlinePeers()

        const lastBlockNumber = await Chain.getLastBlockNumber()
        const lastBlock = await Chain.getBlockByNumber(lastBlockNumber)

        // check if online peers have been online for 3 blocks

        // if its the first block ever or we are doing a regenesis, we might want to skip this check, but we still need a list of reliable nodes.
        // In the "3 block online" the history of online peers is validated by the blockchain AND by the consensus so it can be relied on.

        const peersOnlineForLastThreeBlocks = await Chain.getOnlinePeersForLastThreeBlocks()
        if (peersOnlineForLastThreeBlocks.length > 0) {
            // We found peers that have been online for 3 blocks. Use them in the consensus loop
        }
    
        // In case of it being a new series of blocks with no previously online nodes, we just wait for 3 blocks to pass and populate the list with the peers

        // pick online peers that have been online for 3 blocks for consensus

        // !SECTION Todo list for a typical consensus operation

        if (isConsensusTimeReached) {
            console.log("[MAIN LOOP] Consensus time reached")
            sharedState.getInstance().consensusMode = true
            // TODO Start consensus methods here
            // At the end of the consensus period, the main loop should start again
            sharedState.getInstance().consensusMode = false
        }
    }
    // TODO
}
