/**
 * Petri Consensus — Entry Point
 *
 * This module implements the Petri Consensus protocol:
 * - Instant validation (read-only txs → PRE_APPROVED immediately)
 * - Continuous Forge (2s cycles of speculative execution + delta agreement)
 * - Block finalization (10s boundary, compile PRE_APPROVED txs into blocks)
 * - BFT as exception handler (only for PROBLEMATIC txs with delta disagreement)
 *
 * Lifecycle (per block period):
 *   1. Get shard via CVSA + getShard()
 *   2. Start ContinuousForge (2s loop)
 *   3. Wait for 10s block boundary
 *   4. Pause forge → arbitrate PROBLEMATIC → compile block → finalize → reset
 *   5. Resume forge for next block period
 *
 * Gated by getSharedState.petriConsensus feature flag.
 */

import type { Peer } from "@/libs/peer"
import { getSharedState } from "@/utilities/sharedState"
import { ContinuousForge } from "./forge/continuousForge"
import { setPetriForgeInstance } from "./forge/forgeInstance"
import { compileBlock, cleanRejectedFromMempool } from "./block/petriBlockCompiler"
import { finalizeBlock } from "./block/petriBlockFinalizer"
import { arbitrate } from "./arbitration/bftArbitrator"
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

// Re-export Phase 3 components
export { compileBlock } from "./block/petriBlockCompiler"
export { finalizeBlock } from "./block/petriBlockFinalizer"
export { arbitrate } from "./arbitration/bftArbitrator"

// Re-export Phase 4 components
export { getShardForAddress } from "./routing/shardMapper"
export { selectMembers, relay, getCurrentShard } from "./routing/petriRouter"

// Re-export Phase 5 components
export { getTransactionFinality } from "./finality/transactionFinality"
export type { TransactionFinalityResult } from "./finality/transactionFinality"

/**
 * Helper: sleep for a given duration in ms.
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run one block period: forge for ~blockIntervalMs, then compile and finalize.
 *
 * @param forge - The active ContinuousForge instance
 * @param shard - The current shard members
 * @param blockIntervalMs - Time in ms to run forge before block boundary
 * @returns true if block was finalized, false if block was invalid
 */
async function runBlockPeriod(
    forge: ContinuousForge,
    shard: Peer[],
    blockIntervalMs: number,
): Promise<boolean> {
    // Wait for the block interval (forge is running in background via setTimeout)
    await sleep(blockIntervalMs)

    // Pause forge during block compilation
    forge.pause()
    log.info("[Petri] Block boundary reached — pausing forge for compilation")

    try {
        // Step 1: Arbitrate PROBLEMATIC transactions
        const { resolved, rejectedHashes } = await arbitrate(shard)

        // Step 2: Compile block (PRE_APPROVED + resolved txs)
        const { block, isEmpty } = await compileBlock(shard, resolved)

        if (!block) {
            log.error("[Petri] Block compilation returned null")
            return false
        }

        if (isEmpty) {
            log.info("[Petri] Empty block — finalizing anyway (chain never stalls)")
        }

        // Step 3: Finalize block (vote, insert, broadcast)
        const result = await finalizeBlock(block, shard)

        // Step 4: Clean rejected PROBLEMATIC txs from mempool
        await cleanRejectedFromMempool(rejectedHashes)

        if (result.success) {
            log.info(
                `[Petri] Block #${block.number} finalized: ` +
                `${result.proVotes}/${result.threshold} signatures`,
            )
        } else {
            log.error(
                `[Petri] Block #${block.number} FAILED finalization: ` +
                `${result.proVotes}/${result.threshold} signatures`,
            )
        }

        return result.success
    } finally {
        // Always reset and resume forge, even on failure
        forge.reset()
        forge.resume()
        log.debug("[Petri] Forge reset and resumed for next block period")
    }
}

/**
 * Start the Petri Consensus routine for a given shard.
 * Runs the continuous forge loop with periodic block finalization.
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

    log.info("[Petri] Starting Petri Consensus routine")
    forge.start(shard)

    try {
        // Run one block period (forge → compile → finalize)
        // REVIEW: In the future this could loop for multiple blocks,
        // but for now we match PoRBFT v2's one-block-per-consensus-call pattern.
        await runBlockPeriod(forge, shard, config.blockIntervalMs)
    } catch (error) {
        log.error(`[Petri] Consensus routine error: ${error}`)
    } finally {
        // Stop forge and deregister instance
        forge.stop()
        setPetriForgeInstance(null)
        log.info("[Petri] Petri Consensus routine ended")
    }
}
