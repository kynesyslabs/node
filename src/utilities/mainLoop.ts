import { pki } from "node-forge"
import Chain from "src/libs/blockchain/chain"
import Mempool from "src/libs/blockchain/mempool"
import { fastSync } from "src/libs/blockchain/routines/Sync"
import Transmission from "src/libs/communications/transmission"
import { consensusRoutine } from "src/libs/consensus/v2/PoRBFT" // experimental v2 consensus
import { Identity } from "src/libs/identity"
import { Peer, PeerManager } from "src/libs/peer"

import * as consensusTime from "../libs/consensus/routines/consensusTime"
// INFO The main loop executed in background by index.ts
import sharedState from "./sharedState"
import checkOfflinePeers from "src/libs/peer/routines/checkOfflinePeers"
import log from "src/utilities/logger"

async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

let hasSentNodeOnlineTx = false

export default async function mainLoop() {
    log.info("[MAIN LOOP] ✅ Started")
    var cycleTimestamp: number

    while (sharedState.getInstance().runMainLoop) {
        await sleep(500) // Sleep for 500 ms

        // Get the current UTC time (set the currentUTCTime variable in sharedState)
        await sharedState.getInstance().getUTCTime()
        log.info(`[MAIN LOOP] Current UTC time: ${sharedState.getInstance().currentUTCTime}`)
        
        if (sharedState.getInstance().mainLoopPaused) {
            continue // Check if the main loop is paused
        }
        // If it is not in pause, we set (or force set) the mainLoop flag to be on
        sharedState.getInstance().inMainLoop = true

        // Execute the peer routine before the consensus loop
        let currentlyOnlinePeers: Peer[] = await peerRoutine()
        // we now have a list of online peers that can be used for consensus

        // NOTE Syncing the blockchain
        await fastSync() // REVIEW Test here
        console.log("[MAIN LOOP] Synced! 🟢 ")
        // NOTE Using this as the timestamp of the current cycle
        // eslint-disable-next-line no-unused-vars
        cycleTimestamp = sharedState.getInstance().getTimestamp() // REVIEW Unused
        // NOTE The following routine is capable of checking if the consensus time has been reached automatically with a 100 ms blocking period

        // SECTION Todo list for a typical consensus operation

        // TODO Check if we have to forge the block now
        let isConsensusTimeReached = await consensusTime.checkConsensusTime()

        console.log("[MAINLOOP]: about to check if its time for consensus")

        if (!hasSentNodeOnlineTx && !isConsensusTimeReached) {
            console.log(
                "[MAINLOOP]: is not consensus time and no online node tx",
            )
            //await sendNodeOnlineTx()
        }

        // ! Many times, during the consensus, there is a lot of output before the block is forged. Inspect why
        // ? Is there an hello_peer loop? Or are the semaphores broken?
        // ? Looks like  we re-enter in the loop without finishing the previous one.
        // ? Also due to this (presumably) sometimes a node adds twice the same block
        /*
            [INFO] [2024-08-29T11:51:11.698Z] [consensusRoutine] Threshold: 2
            [INFO] [2024-08-29T11:51:11.698Z] [consensusRoutine] Total votes: 2
            [INFO] [2024-08-29T11:51:11.699Z] [consensusRoutine] [result] Block is valid with 2 votes
            [INFO] [2024-08-29T11:51:11.699Z] [consensusRoutine] Block is valid with 2 votes
            [CHAIN] reading hash
            []
            [CHAIN] bork
            [ChainDB] [ INFO ]: Checking if block with position undefined already exists
            [ChainDB] [ INFO ]: Found block with null position, possibly genesis block
            [ChainDB] [ INFO ]: Block with position undefined does not exist: inserting a new block
            [CONSENSUS TIME] lastTimestamp: 1724932238313
            [CONSENSUS TIME] currentTimestamp: 1724932271588
            [CONSENSUS TIME] delta: 33275
            [CONSENSUS TIME] consensusIntervalTime: 10000
            [CONSENSUS TIME] Consensus time reached
            [INFO] [2024-08-29T11:51:11.700Z] [manageConsensusRoutines] We are within the consensus time window
            ...
        */
        // NOTE We need both the consensus time and the sync status to be true, to avoid
        // conflicts with the sync loop that would lead to a failure in the consensus mechanism.
        if (isConsensusTimeReached && sharedState.getInstance().syncStatus && !sharedState.getInstance().startingConsensus) {
            // Set the startingConsensus flag to true to avoid conflicts with starting loops
            sharedState.getInstance().startingConsensus = true
            log.info("[MAIN LOOP] Consensus time reached and sync status is true")
            await consensusRoutine()
        } else if (!sharedState.getInstance().syncStatus) {
            // ? This is a bit redundant, isn't it?
            console.log(
                "[MAIN LOOP] Cannot start consensus, not in sync. Sync loop should start automatically",
            )
        }
    }
}

// ANCHOR Unified peer routine
async function peerRoutine(): Promise<Peer[]> {
    // Logging the current peerlist
    log.info("[PEERROUTINE] Logging peerlist")
    PeerManager.getInstance().logPeerList()

    // REVIEW Re check offline peers asynchronously
    console.log("[MAINLOOP]: checking offline peers")
    checkOfflinePeers() // NOTE This is an async method that will be executed in the background
    console.log("[MAINLOOP]: checked offline peers")

    // every block write online list
    console.log("[MAINLOOP]: getting online peers")
    const onlinePeers = await PeerManager.getInstance().getOnlinePeers()
    console.log("[MAINLOOP]: got online peers")

    // check if online peers have been online for 3 blocks

    // if its the first block ever or we are doing a regenesis, we might want to skip this check, but we still need a list of reliable nodes.
    // In the "3 block online" the history of online peers is validated by the blockchain AND by the consensus so it can be relied on.

    let currentlyOnlinePeers: Peer[] 

    console.log("[MAINLOOP]: getting online peers for last three blocks")
    const peersOnlineForLastThreeBlocks =
        await Chain.getOnlinePeersForLastThreeBlocks() // ! REVIEW if this works with hello_peer

    if (peersOnlineForLastThreeBlocks.length > 0) {
        // We found peers that have been online for 3 blocks. Use them in the consensus loop
        currentlyOnlinePeers = peersOnlineForLastThreeBlocks
    } else {
        // We didn't find peers that have been online for 3 blocks. Use the online peers list as it is
        // In this case we assume the node is isolated, starting up or that other nodes are not online or still connencting to the network
        console.log("using online peers list as it is")
        currentlyOnlinePeers = onlinePeers  
    }

    console.log("Family:")
    let famLen = currentlyOnlinePeers.length
    let famString = ""
    for (let i = 0; i < famLen; i++) {
        famString += "🐸 "
    }
    console.log(famString)

    // Returns the list of currently online peers
    return currentlyOnlinePeers
}
