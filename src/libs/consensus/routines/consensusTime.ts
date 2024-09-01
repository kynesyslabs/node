import Chain from "src/libs/blockchain/chain"
import log from "src/utilities/logger"
import sharedState from "src/utilities/sharedState"
import terminalkit from "terminal-kit"

const term = terminalkit.terminal

export async function checkConsensusTime(
    flexible: boolean = false,
    flextime: number = 2000,
): Promise<boolean> {
    // Safeguard to prevent the consensus time from being checked before the last block is forged
    if (sharedState.getInstance().inConsensusLoop) {
        log.warning("[CONSENSUS TIME] Cannot check consensus time while in consensus loop, skipping")
        return false
    }
    let isConsensusTime = false
    // Using the average timestamp set in the last block
    //let lastTimestamp = await sharedState.getInstance().getLastConsensusTime() // ? Should we check it from the blockchain each time?
    let lastBlock = await Chain.getLastBlock()
    let lastTimestamp = lastBlock.content.timestamp
    // REVIEW Using the UTC timestamp as per mainLoop.ts settings
    let currentTimestamp = sharedState.getInstance().currentUTCTime // Date.now()
    let delta = currentTimestamp - lastTimestamp
    let consensusIntervalTime =
        sharedState.getInstance().getConsensusTime() || 10000
    console.log("[CONSENSUS TIME] lastTimestamp: " + lastTimestamp)
    console.log("[CONSENSUS TIME] currentTimestamp: " + currentTimestamp)
    console.log("[CONSENSUS TIME] delta: " + delta)
    console.log(
        "[CONSENSUS TIME] consensusIntervalTime: " + consensusIntervalTime,
    )
    //process.exit(0)

    // If the delta is greater than the consensus interval time, then the consensus time has passed
    console.log(
        "[CONSENSUS TIME] consensusIntervalTime: " + consensusIntervalTime,
    )
    if (delta > consensusIntervalTime) {
        isConsensusTime = true
        console.log("[CONSENSUS TIME] Consensus time reached")
    } else {
        // REVIEW Allow a small leeway for the consensus time
        if (flexible) {
            // Calculate if the delta is within the flexible time
            let maxDelta = consensusIntervalTime + flextime
            let minDelta = consensusIntervalTime - flextime
            if (delta > minDelta && delta < maxDelta) {
                isConsensusTime = true
                console.log("[CONSENSUS TIME] Consensus time reached")
            }
        }
    }
    if (!isConsensusTime) {
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
