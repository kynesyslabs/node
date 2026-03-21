
/**
 * @deprecated Replaced by Petri Consensus classification types (TransactionClassification).
 * Kept for PoRBFT v2 fallback via feature flag.
 *
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
    | "synchronizedTime"
    | "mergedMempool"
    | "appliedGCR"
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
        2: ["synchronizedTime", false],
        3: ["mergedMempool", false],
        4: ["appliedGCR", false],
        5: ["forgedBlock", false],
        6: ["votedOnBlock", false],
        7: ["readyToEndConsensus", false],
        // IMPORTANT: If you add a new phase, update SecretaryManager.receiveValidatorPhase
        // to use the new phase number for checking the last step
    },
    blockReferenced: 0,
}