import sharedState from "src/utilities/sharedState"

import terminalkit from "terminal-kit"
var term = terminalkit.terminal

export async function checkConsensusTime(): Promise<boolean> {
    let isConsensusTime = false
    let consensusIntervalTime =
        sharedState.getInstance().getConsensusTime() || 10000
    // Calculate the delta between the current timestamp and the genesis timestamp
    let delta = await sharedState.getInstance().getTimePassed()
    // If the delta is greater than the consensus interval time, then the consensus time has passed
    console.log(
        "[CONSENSUS TIME] consensusIntervalTime: " + consensusIntervalTime,
    )
    if (delta > consensusIntervalTime) {
        isConsensusTime = true
        console.log("[CONSENSUS TIME] Consensus time reached")
    } else {
        console.log("[CONSENSUS TIME] Consensus time not reached")
    }
    // We can return the result
    return isConsensusTime
}

// INFO Helper function for the checkConsensusTime() function
export async function waitForConsensusTime(): Promise<boolean> {
    let timer = 0
    let isConsensusTime = false
    checkConsensusTime().then((conTime: boolean) => {
        isConsensusTime = conTime
    })
    // Waiting here
    while (!isConsensusTime) {
        // NOTE Checking once every 1 second
        await new Promise(resolve => setTimeout(resolve, 1000))
        timer += 1
        if (timer > 6) {
            term.red.bold(
                "\n[WARNING] The consensus time has not been reached in 6 seconds\n\n",
            )
            timer = 0
        }
    }
    term.green.bold("[OK] Consensus time reached!\n")
    return isConsensusTime
}
