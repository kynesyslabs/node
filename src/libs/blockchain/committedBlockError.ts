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
