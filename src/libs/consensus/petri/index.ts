/**
 * Petri Consensus — Entry Point
 *
 * This module implements the Petri Consensus protocol:
 * - Instant validation (read-only txs → PRE_APPROVED immediately)
 * - Continuous Forge (2s cycles of speculative execution + delta agreement)
 * - Block finalization (10s boundary, compile PRE_APPROVED txs into blocks)
 * - BFT as exception handler (only for PROBLEMATIC txs with delta disagreement)
 *
 * Gated by getSharedState.petriConsensus feature flag.
 */

// Re-export types
export { TransactionClassification } from "./types/classificationTypes"
export type { ClassifiedTransaction } from "./types/classificationTypes"
export type { StateDelta, PeerDelta } from "./types/stateDelta"
export type {
    ContinuousForgeRound,
    ForgeConfig,
    ForgeState,
} from "./types/continuousForgeTypes"
export type { PetriConfig } from "./types/petriConfig"
export { DEFAULT_PETRI_CONFIG } from "./types/petriConfig"
export type {
    DeltaComparison,
    RoundDeltaResult,
} from "./types/deltaComparison"

// REVIEW: Stub — Phase 1+ will implement the actual consensus routine
// eslint-disable-next-line @typescript-eslint/no-empty-function
export async function petriConsensusRoutine(): Promise<void> {
    // Will be implemented in Phase 2 (Continuous Forge)
}
