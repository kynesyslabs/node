import Chain from "src/libs/blockchain/chain"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import terminalkit from "terminal-kit"

const term = terminalkit.terminal

export async function checkConsensusTime(
    flexible: boolean = false,
    flextime: number = 2,
): Promise<boolean> {
    // Safeguard to prevent the consensus time from being checked before the last block is forged
    if (getSharedState.inConsensusLoop) {
        log.warning("[CONSENSUS TIME] Cannot check consensus time while in consensus loop, skipping")
        return false
    }
    let isConsensusTime = false
    // Using the average timestamp set in the last block
    //let lastTimestamp = await getSharedState.getLastConsensusTime() // ? Should we check it from the blockchain each time?
    let lastBlock = await Chain.getLastBlock()
    let lastTimestamp = lastBlock.content.timestamp
    // REVIEW Using the UTC timestamp as per mainLoop.ts settings
    let currentTimestamp = getNetworkTimestamp() // Date.now()
    let delta = currentTimestamp - lastTimestamp
    let consensusIntervalTime =
        getSharedState.getConsensusTime() || 10 // 10 seconds, use 10000 for 10 seconds in ms
    log.info("[CONSENSUS TIME] lastTimestamp: " + lastTimestamp, true)
    log.info("[CONSENSUS TIME] currentTimestamp: " + currentTimestamp, true)
    log.info("[CONSENSUS TIME] delta: " + delta, true)
    log.info("[CONSENSUS TIME] consensusIntervalTime: " + consensusIntervalTime, true)
    //process.exit(0)

    // If the delta is greater than the consensus interval time, then the consensus time has passed
    log.info("[CONSENSUS TIME] consensusIntervalTime: " + consensusIntervalTime, false)
    if (delta >= consensusIntervalTime) {
        isConsensusTime = true
        log.info("[CONSENSUS TIME] Consensus time reached", true)
    } else {
        // REVIEW Allow a small leeway for the consensus time
        if (flexible) {
            // Calculate if the delta is within the flexible time
            let maxDelta = consensusIntervalTime + flextime
            let minDelta = consensusIntervalTime - flextime
            if (delta > minDelta && delta < maxDelta) {
                isConsensusTime = true
                log.info("[CONSENSUS TIME] Consensus time reached (with flexible time and delta: " + delta + ")", true)
            }
        }       
    }
    if (!isConsensusTime) {
        log.info("[CONSENSUS TIME] Consensus time not reached", true)
    }
    // We can return the result
    return isConsensusTime
}


