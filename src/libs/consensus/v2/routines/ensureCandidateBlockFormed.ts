import { getSharedState } from "src/utilities/sharedState"
import { consensusRoutine } from "../PoRBFT"
import log from "src/utilities/logger"
import { checkConsensusTime } from "src/libs/consensus/routines/consensusTime"
// import { getShardManager } from "./shardManager"

export default async function ensureCandidateBlockFormed(): Promise<boolean> {
    let success = false
    if (!getSharedState.candidateBlock) {
        log.info(
            "Candidate block not formed yet, forcing the consensus routine...",
        )
        if (!getSharedState.inConsensusLoop) {
            if (!(await checkConsensusTime(true, 2))) {
                log.warning(
                    "[ensureCandidateBlockFormed] Consensus time not reached: refusing to force a round",
                )
                return false
            }
            await consensusRoutine()
        } else {
            log.info(
                "Consensus routine already running, waiting for it to finish...",
            )
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