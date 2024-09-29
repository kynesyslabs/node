import Chain from "src/libs/blockchain/chain"
import { fastSync } from "src/libs/blockchain/routines/Sync"
import { consensusRoutine } from "src/libs/consensus/v2/PoRBFT"
import { Peer, PeerManager } from "src/libs/peer"
import checkOfflinePeers from "src/libs/peer/routines/checkOfflinePeers"
import log from "src/utilities/logger"

import * as consensusTime from "../libs/consensus/routines/consensusTime"
import { getSharedState } from "./sharedState"

// INFO The main loop executed in background by index.ts
async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

let hasSentNodeOnlineTx = false

export default async function mainLoop() {
    log.info("[MAIN LOOP] ✅ Started")
    var cycleTimestamp: number

    while (getSharedState.runMainLoop) {
        await sleep(500) // Sleep for 500 ms
        log.info("\n============================================================\n", true)
        // Get the current UTC time (set the currentUTCTime variable in sharedState)
        await getSharedState.getUTCTime()
        log.info(`[MAIN LOOP] Current UTC time: ${getSharedState.currentUTCTime}`)
        
        if (getSharedState.mainLoopPaused) {
            continue // Check if the main loop is paused
        }
        // If it is not in pause, we set (or force set) the mainLoop flag to be on
        getSharedState.inMainLoop = true

        // Execute the peer routine before the consensus loop
        /* NOTE The peerRoutine also checks getOnlinePeers, so it works by waiting for
           getSharedState.peerRoutineRunning to be 0 so we don't get into conflicts while
           running the consensus routine. */
        let currentlyOnlinePeers: Peer[] = await peerRoutine()
        // we now have a list of online peers that can be used for consensus

        // NOTE Syncing the blockchain
        await fastSync() // REVIEW Test here
        log.info("[MAIN LOOP] Synced! 🟢", true)
        // NOTE Using this as the timestamp of the current cycle
        // eslint-disable-next-line no-unused-vars
        cycleTimestamp = getSharedState.getTimestamp() // REVIEW Unused
        // NOTE The following routine is capable of checking if the consensus time has been reached automatically with a 100 ms blocking period

        // SECTION Todo list for a typical consensus operation

        // TODO Check if we have to forge the block now
        let isConsensusTimeReached = await consensusTime.checkConsensusTime()

        log.info("[MAINLOOP]: about to check if its time for consensus", false)

        if (!hasSentNodeOnlineTx && !isConsensusTimeReached) {
            log.info("[MAINLOOP]: is not consensus time", false)
            //await sendNodeOnlineTx()
        }

        
        // NOTE We need both the consensus time and the sync status to be true, to avoid
        // conflicts with the sync loop that would lead to a failure in the consensus mechanism.
        if (isConsensusTimeReached && getSharedState.syncStatus && !getSharedState.startingConsensus) {
            // Set the startingConsensus flag to true to avoid conflicts with starting loops
            getSharedState.startingConsensus = true
            log.info("[MAIN LOOP] Consensus time reached and sync status is true")
            // Wait for the peer routine to finish if it is still running
            log.info("[MAIN LOOP] Waiting for the peer routine to finish")
            let timer = 0
            while (getSharedState.peerRoutineRunning > 0) {
                await sleep(100)
                timer += 1
                if (timer > 10) {
                    log.error("[MAIN LOOP] Peer routine is taking too long to finish: forcing consensus")
                    getSharedState.peerRoutineRunning = 0 // Force the peer routine to act as if it finished
                    break
                }
            }
            await consensusRoutine()
        } else if (!getSharedState.syncStatus) {
            // ? This is a bit redundant, isn't it?
            log.warning("[MAIN LOOP] Cannot start consensus, not in sync. Sync loop should start automatically", true)
        }
    }
}

// ANCHOR Unified peer routine
async function peerRoutine(): Promise<Peer[]> {
    // Logging the current peerlist
    log.info("[PEERROUTINE] Logging peerlist", false)
    PeerManager.getInstance().logPeerList()

    // REVIEW Re check offline peers asynchronously
    log.info("[MAINLOOP]: checking offline peers", false)
    checkOfflinePeers() // NOTE This is an async method that will be executed in the background
    log.info("[MAINLOOP]: checked offline peers", false)

    // every block write online list
    log.info("[MAINLOOP]: getting online peers", false)
    const onlinePeers = await PeerManager.getInstance().getOnlinePeers()
    log.info("[MAINLOOP]: got online peers", false)

    // check if online peers have been online for 3 blocks

    // if its the first block ever or we are doing a regenesis, we might want to skip this check, but we still need a list of reliable nodes.
    // In the "3 block online" the history of online peers is validated by the blockchain AND by the consensus so it can be relied on.

    let currentlyOnlinePeers: Peer[] 

    log.info("[MAINLOOP]: getting online peers for last three blocks", false)
    const peersOnlineForLastThreeBlocks =
        await Chain.getOnlinePeersForLastThreeBlocks() // ! REVIEW if this works with hello_peer

    if (peersOnlineForLastThreeBlocks.length > 0) {
        // We found peers that have been online for 3 blocks. Use them in the consensus loop
        currentlyOnlinePeers = peersOnlineForLastThreeBlocks
    } else {
        // We didn't find peers that have been online for 3 blocks. Use the online peers list as it is
        // In this case we assume the node is isolated, starting up or that other nodes are not online or still connencting to the network
        log.info("[MAINLOOP]: using online peers list as it is", false)
        currentlyOnlinePeers = onlinePeers  
    }

    log.info("[MAINLOOP]: family:", true)
    let famLen = currentlyOnlinePeers.length
    let famString = ""
    for (let i = 0; i < famLen; i++) {
        famString += "🐸 "
    }
    log.info("[MAINLOOP]: family: " + famString, true)

    // Returns the list of currently online peers
    return currentlyOnlinePeers
}
