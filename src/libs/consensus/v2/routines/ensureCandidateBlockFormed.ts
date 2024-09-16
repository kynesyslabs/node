import sharedState from "src/utilities/sharedState"
import { consensusRoutine } from "../PoRBFT"
import log from "src/utilities/logger"

export default async function ensureCandidateBlockFormed(): Promise<boolean> {
    
    let success = false
    if (!sharedState.getInstance().candidateBlock) {
        log.info("Candidate block not formed yet, forcing the consensus routine...")
        if (!sharedState.getInstance().inConsensusLoop) {
            await consensusRoutine()
        } else {
            log.info("Consensus routine already running, waiting for it to finish...")
        }
    }
    if (sharedState.getInstance().candidateBlock) {
        success = true
    }
    return success
}