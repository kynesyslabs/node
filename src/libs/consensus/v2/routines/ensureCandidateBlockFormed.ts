import { getSharedState } from "src/utilities/sharedState"
import { consensusRoutine } from "../PoRBFT"
import log from "src/utilities/logger"
// import { getShardManager } from "./shardManager"

export default async function ensureCandidateBlockFormed(): Promise<boolean> {
    let success = false
    if (!getSharedState.candidateBlock) {
        // REVIEW: When Petri consensus is active, the candidate block is compiled by
        // PetriBlockCompiler — never fall back to the PoRBFT consensusRoutine.
        // Instead, wait briefly for the Petri forge to compile the block.
        if (getSharedState.petriConsensus) {
            log.info(
                "[ensureCandidateBlockFormed] Petri active — waiting for Petri block compilation...",
            )
            // Wait up to 5s for Petri to set candidateBlock
            for (let i = 0; i < 50; i++) {
                if (getSharedState.candidateBlock) break
                await new Promise(r => setTimeout(r, 100))
            }
        } else {
            log.info(
                "Candidate block not formed yet, forcing the consensus routine...",
            )
            if (!getSharedState.inConsensusLoop) {
                await consensusRoutine()
            } else {
                log.info(
                    "Consensus routine already running, waiting for it to finish...",
                )
            }
        }
    }

    // const ourValidatorStatus = getShardManager.shardStatus.get(
    //     getSharedState.identity.ed25519.publicKey.toString("hex"),
    // )
    // log.info(
    //     "Our validator status: " + JSON.stringify(ourValidatorStatus, null, 2),
    // )

    if (getSharedState.candidateBlock) {
        success = true
    }

    return success
}