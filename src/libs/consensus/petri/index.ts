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

import type { Peer } from "@/libs/peer"
import { getSharedState } from "@/utilities/sharedState"
import { ContinuousForge } from "./forge/continuousForge"
import { setPetriForgeInstance } from "./forge/forgeInstance"
import log from "@/utilities/logger"

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

// Re-export Phase 2 components
export { ContinuousForge } from "./forge/continuousForge"
export { DeltaAgreementTracker } from "./forge/deltaAgreementTracker"

/**
 * Start the Petri Consensus routine for a given shard.
 * Creates and starts the ContinuousForge loop.
 * Called from the consensus dispatch when petriConsensus flag is on.
 *
 * @param shard - The shard members for this consensus round
 */
export async function petriConsensusRoutine(shard: Peer[]): Promise<void> {
    if (!getSharedState.petriConsensus) {
        log.warn("[Petri] petriConsensusRoutine called but flag is off")
        return
    }

    const config = getSharedState.petriConfig
    const forge = new ContinuousForge(config)

    // Register the forge instance so the RPC handler can access it
    setPetriForgeInstance(forge)

    log.info("[Petri] Starting Continuous Forge for shard")
    forge.start(shard)

    // REVIEW: Phase 3 will add block finalization logic here.
    // For now, the forge runs until stopped externally.
}
