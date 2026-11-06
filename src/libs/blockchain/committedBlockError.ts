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
