// INFO The main loop executed in background by index.ts
import sharedState from "./sharedState"
import * as consensusTime from "../libs/consensus/routines/consensusTime"
import Sync from "src/libs/blockchain/routines/Sync"
import { Identity } from "src/libs/identity"

async function sleep(time: number) {
    return new Promise((resolve) => setTimeout(resolve, time))
}

export default async function mainLoop(id: Identity) {
    console.log("[MAIN LOOP] Started")
    var cycleTimestamp: number
    while(sharedState.getInstance().runMainLoop) {
        await sleep(500) // Sleep for 1 second
        if (sharedState.getInstance().mainLoopPaused) continue // Check if the main loop is paused
        // NOTE Syncing the blockchain
        await Sync(id)
        // NOTE Using this as the timestamp of the current cycle
        cycleTimestamp = sharedState.getInstance().getTimestamp() // REVIEW Unused
        // NOTE The following routine is capable of checking if the consensus time has been reached automatically with a 100 ms blocking period
        let isConsensusTimeReached = await consensusTime.checkConsensusTime()
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