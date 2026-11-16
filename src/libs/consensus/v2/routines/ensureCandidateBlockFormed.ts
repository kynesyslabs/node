import { getSharedState } from "src/utilities/sharedState"
import { consensusRoutine } from "../PoRBFT"
import log from "src/utilities/logger"
import { checkConsensusTime } from "src/libs/consensus/routines/consensusTime"
import { sleep } from "@kynesyslabs/demosdk/utils"
// import { getShardManager } from "./shardManager"

// Below the proposer's 3 s per-attempt timeout, so a proposal that arrives
// while our round is still merging mempools gets an answer instead of a 404
// the proposer counts as a con vote. Each proposer retry waits again.
export const CANDIDATE_WAIT_MS = 2000
const CANDIDATE_POLL_MS = 100

export default async function ensureCandidateBlockFormed(
    waitMs = CANDIDATE_WAIT_MS,
): Promise<boolean> {
    let success = false
    if (!getSharedState.candidateBlock) {
        if (!getSharedState.runMainLoop) return false
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
                "Consensus routine already running, waiting for it to form the candidate...",
            )
            const deadline = Date.now() + waitMs
            while (
                !getSharedState.candidateBlock &&
                getSharedState.inConsensusLoop &&
                Date.now() < deadline
            ) {
                await sleep(CANDIDATE_POLL_MS)
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
