import Chain from "src/libs/blockchain/chain"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import terminalkit from "terminal-kit"

const term = terminalkit.terminal

export async function checkConsensusTime(
    flexible = false,
    flextime = 2,
): Promise<boolean> {
    // Safeguard to prevent the consensus time from being checked before the last block is forged
    if (getSharedState.inConsensusLoop) {
        return false
    }

    let isConsensusTime = false
    // Using the average timestamp set in the last block
    //let lastTimestamp = await getSharedState.getLastConsensusTime() // ? Should we check it from the blockchain each time?
    const lastBlock = await Chain.getLastBlock()
    log.debug(`LAST BLOCK NUMBER: ${lastBlock.number}`)
    log.debug("--------------------------------")
    log.debug(`LAST BLOCK: ${lastBlock.hash}`)
    log.debug("--------------------------------")
    const lastTimestamp = lastBlock.content.timestamp
    // REVIEW Using the UTC timestamp as per mainLoop.ts settings
    const currentTimestamp = getNetworkTimestamp() // Date.now()
    const delta = currentTimestamp - lastTimestamp
    const consensusIntervalTime = getSharedState.getConsensusTime()
    log.debug(`[CONSENSUS TIME] lastTimestamp: ${lastTimestamp}`, true)
    log.debug(`[CONSENSUS TIME] currentTimestamp: ${currentTimestamp}`, true)
    log.debug(`[CONSENSUS TIME] delta: ${delta}`)
    log.debug(
        `[CONSENSUS TIME] consensusIntervalTime: ${consensusIntervalTime}`,
        true,
    )

    // If the delta is greater than the consensus interval time, then the consensus time has passed
    log.info(
        `[CONSENSUS TIME] consensusIntervalTime: ${consensusIntervalTime}`,
        false,
    )
    if (delta >= consensusIntervalTime) {
        isConsensusTime = true
        log.info("[CONSENSUS TIME] Consensus time reached", true)
    } else {
        // REVIEW Allow a small leeway for the consensus time
        if (flexible) {
            // Calculate if the delta is within the flexible time
            const maxDelta = consensusIntervalTime + flextime
            const minDelta = consensusIntervalTime - flextime
            if (delta > minDelta && delta < maxDelta) {
                isConsensusTime = true
                log.info(
                    "[CONSENSUS TIME] Consensus time reached (with flexible time and delta: " +
                        delta +
                        ")",
                    true,
                )
            }
        }
    }
    if (!isConsensusTime) {
        log.info("[CONSENSUS TIME] Consensus time not reached", true)
    }
    // We can return the result
    return isConsensusTime
}
