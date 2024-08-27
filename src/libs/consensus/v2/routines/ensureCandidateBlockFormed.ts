import sharedState from "src/utilities/sharedState"
import { consensusRoutine } from "../PoRBFT"
import log from "src/utilities/logger"

export default async function ensureCandidateBlockFormed(): Promise<boolean> {
    
    let success = false
    if (!sharedState.getInstance().candidateBlock) {
        log.info("Candidate block not formed yet, forcing the consensus routine...")
        await consensusRoutine()
    }
    if (sharedState.getInstance().candidateBlock) {
        success = true
    }
    return success
}