
/**
 * Example of the validation phase object
 * {
 *  waitStatus: true,
 *  currentPhase: 2,
 *  phases: {
 *      0: ["enteredConsensus", true],
 *      1: ["exchangedMempool", true],
 *      2: ["mergedMempool", false],
 *      3: ["forgedBlock", false],
 *      4: ["votedOnBlock", false],
 *      5: ["readyToEndConsensus", false]
 *  },
 *  blockReferenced: 14
 * }
 */

// The status of each phase of the consensus
export type ValidationPhaseStatus =
    | "enteredConsensus"
    | "exchangedMempool"
    | "mergedMempool"
    | "forgedBlock"
    | "votedOnBlock"
    | "readyToEndConsensus"

// Each shard member has a validation phase object used to track the progress of the consensus
export interface ValidationPhase {
    waitStatus: boolean
    currentPhase: number
    phases: {
        [key: number]: [ValidationPhaseStatus, boolean]
    }
    blockReferenced: number
}

// Each shard member's validation phase object is initialized with the below values
export const emptyValidationPhase: ValidationPhase = {
    waitStatus: false,
    currentPhase: 0,
    phases: {
        1: ["enteredConsensus", false],
        2: ["exchangedMempool", false],
        3: ["mergedMempool", false],
        4: ["forgedBlock", false],
        5: ["votedOnBlock", false],
        6: ["readyToEndConsensus", false],
    },
    blockReferenced: 0,
}