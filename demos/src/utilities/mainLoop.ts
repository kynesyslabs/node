// INFO The main loop executed in background by index.ts
import sharedState from "./sharedState"
import * as consensusTime from "../libs/consensus/routines/consensusTime"

async function sleep(time: number) {
    return new Promise((resolve) => setTimeout(resolve, time))
}

export default async function mainLoop() {
    console.log("[MAIN LOOP] Started")
    var cycleTimestamp: number
    while(sharedState.getInstance().runMainLoop) {
        await sleep(100) // Sleep for 1 second
        if (sharedState.getInstance().mainLoopPaused) continue // Check if the main loop is paused
        // Using this as the timestamp of the current cycle
        cycleTimestamp = sharedState.getInstance().getTimestamp() // REVIEW Unused
        // The following routine is capable of checking if the consensus time has been reached automatically with a 100 ms blocking period
        let isConsensusTimeReached = await consensusTime.checkConsensusTime()
        if (isConsensusTimeReached) {
            console.log("[MAIN LOOP] Consensus time reached")
            sharedState.getInstance().consensusMode = true
            sharedState.getInstance().mainLoopPaused = true
            // TODO Start consensus methods here
            // At the end of the consensus period, the main loop should start again
            sharedState.getInstance().mainLoopPaused = false
            sharedState.getInstance().consensusMode = false
        }
    }
    // TODO
}