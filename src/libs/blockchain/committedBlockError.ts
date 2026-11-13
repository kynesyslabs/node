import { haltSigning, signingHaltReason } from "src/libs/identity/signingRecord"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

/**
 * A block's database transaction committed, but a step that brings memory up
 * to the block failed. Disk is ahead of memory, so the node cannot go on as
 * it is: only a restart derives memory from disk again.
 */
export class CommittedBlockFollowUpError extends Error {
    constructor(blockNumber: number, cause: unknown) {
        super(`Block ${blockNumber} committed but its follow-up failed: ${cause}`)
        this.name = "CommittedBlockFollowUpError"
    }
}

/**
 * A block's database transaction failed in a way that does not say whether
 * it committed, such as a COMMIT whose reply was lost. Disk may be ahead of
 * memory, so it is handled as a committed block whose follow-up failed.
 */
export class BlockCommitUnknownError extends CommittedBlockFollowUpError {
    constructor(blockNumber: number, cause: unknown) {
        super(blockNumber, cause)
        this.message = `Block ${blockNumber} may have committed: ${cause}`
        this.name = "BlockCommitUnknownError"
    }
}

/**
 * Stops the node over a block whose follow-up failed. The main loop and
 * signing stop at once:
 * memory may be a block behind disk, so new rounds and GCR recovery must
 * refuse to run against that stale head. The in-flight synced block apply
 * drains and the servers stop before gracefulShutdown exits with code 1.
 * On restart, memory is derived from disk.
 */
export function stopAfterCommittedBlockFailure(error: CommittedBlockFollowUpError): void {
    getSharedState.runMainLoop = false
    if (haltSigning(error.message)) {
        log.error(`[SIGNING] stopped until this process exits: ${error.message}`)
    } else {
        log.error(`[SIGNING] already stopped (${signingHaltReason()}); exiting after: ${error.message}`)
    }
    void import("src/index")
        .then(({ gracefulShutdown }) => gracefulShutdown("committed_block_follow_up", 1))
        .catch(() => process.exit(1))
}
