import sharedState from "src/utilities/sharedState"
const term = require("terminal-kit").terminal

export async function checkConsensusTime(): Promise<boolean> {
    let isConsensusTime = false
    let consensusIntervalTime = sharedState.getInstance().getConsensusTime()
    // TODO Retrieve the genesis timestamp from the database
    let genesisTimestamp = 0
    // Calculate the delta between the current timestamp and the genesis timestamp
    let delta = sharedState.getInstance().getTimePassed(genesisTimestamp)
    // If the delta is greater than the consensus interval time, then the consensus time has passed
    if (delta > consensusIntervalTime) {
        isConsensusTime = true
    }
    // We can return the result
    return isConsensusTime
}

// INFO Helper function for the checkConsensusTime() function
export async function waitForConsensusTime(): Promise<boolean> {
    let timer = 0
    let isConsensusTime = false
    checkConsensusTime()
        .then((conTime: boolean) => {
            isConsensusTime = conTime
        })
    // Waiting here
    while (!isConsensusTime) {
        // NOTE Checking once every 1 second
        await new Promise(resolve => setTimeout(resolve, 1000))
        timer += 1
        if (timer > 6) {
            term.red.bold("\n[WARNING] The consensus time has not been reached in 6 seconds\n\n")
            timer = 0
        }
    }
    term.green.bold("[OK] Consensus time reached!\n")
    return isConsensusTime
}




