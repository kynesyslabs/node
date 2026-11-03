import { Mutex } from "async-mutex"

/**
 * Serialises every writer of the GCR tables. A block's state edits commit
 * inside the block's own database transaction, so the block insert holds
 * this too.
 */
export const gcrWriteMutex = new Mutex()
