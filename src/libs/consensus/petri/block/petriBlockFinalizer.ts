/**
 * PetriBlockFinalizer — Petri Consensus Phase 3 + Phase 9
 *
 * Secretary-driven block finalization using broadcast model:
 *   1. Secretary compiles the candidate block
 *   2. Secretary broadcasts the block hash to shard peers (push model)
 *   3. Peers independently verify (compile their own block, compare hash)
 *   4. Peers sign only if hashes match (verify-then-sign via manageProposeBlockHash)
 *   5. Secretary collects signatures from responses, checks BFT threshold
 *   6. If threshold met: inserts block + broadcasts finalized block
 *
 * Non-secretary members wait for the finalized block via existing sync.
 */

import type { Peer } from "@/libs/peer"
import type Block from "@/libs/blockchain/block"
import { insertBlock } from "@/libs/blockchain/chainBlocks"
import { BroadcastManager } from "@/libs/communications/broadcastManager"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import { isWeSecretary } from "@/libs/consensus/petri/coordination/petriSecretary"
import { broadcastBlockHash } from "@/libs/consensus/v2/routines/broadcastBlockHash"

export interface FinalizationResult {
    success: boolean
    /** The finalized block (with accumulated signatures) */
    block: Block
    /** Number of pro votes (signatures) */
    proVotes: number
    /** Number of con votes */
    conVotes: number
    /** BFT threshold required */
    threshold: number
}

/**
 * Finalize a compiled block.
 *
 * Secretary: broadcasts block hash to shard peers, collects verify-then-sign
 * responses, inserts block if BFT threshold is met.
 *
 * Member: does nothing here — the block will arrive via broadcast/sync
 * after the secretary finalizes it. The member's verify-then-sign happens
 * when the secretary's broadcastBlockHash triggers manageProposeBlockHash.
 *
 * @param block - The candidate block from PetriBlockCompiler
 * @param shard - The current shard members
 * @returns FinalizationResult indicating success/failure
 */
export async function finalizeBlock(
    block: Block,
    shard: Peer[],
): Promise<FinalizationResult> {
    const blockNumber = block.number
    const hashShort = block.hash.substring(0, 16)
    const totalMembers = shard.length + 1 // shard peers + us
    const threshold = Math.floor((totalMembers * 2) / 3) + 1

    log.info(`[PetriBlockFinalizer] Finalizing block #${blockNumber} (${hashShort}...)`)

    if (isWeSecretary(shard)) {
        return await secretaryFinalize(block, shard, totalMembers, threshold)
    }

    return await memberFinalize(block, shard, totalMembers, threshold)
}

/**
 * Secretary path: broadcast block hash to peers, collect verify-then-sign
 * responses, insert and broadcast if threshold is met.
 */
async function secretaryFinalize(
    block: Block,
    shard: Peer[],
    totalMembers: number,
    threshold: number,
): Promise<FinalizationResult> {
    const blockNumber = block.number

    log.info(`[PetriBlockFinalizer] We are SECRETARY for block #${blockNumber}`)

    // Set candidate block so broadcastBlockHash can read signatures from it
    getSharedState.candidateBlock = block

    // Broadcast our block hash to all shard peers.
    // Each peer runs manageProposeBlockHash which, with Petri active,
    // compiles its own block, compares hashes, and only signs if they match.
    const [pro, con] = await broadcastBlockHash(block, shard)

    const signatureCount = Object.keys(block.validation_data.signatures).length

    log.info(
        `[PetriBlockFinalizer] Block #${blockNumber}: ` +
        `${signatureCount} signatures (pro=${pro}, con=${con}, threshold=${threshold})`,
    )

    // Check BFT threshold
    if (signatureCount >= threshold) {
        log.info(
            `[PetriBlockFinalizer] Block #${blockNumber} PASSED threshold — inserting`,
        )

        // Insert block into chain
        await insertBlock(block)

        // Broadcast finalized block to the full network
        await BroadcastManager.broadcastNewBlock(block)

        // Clear candidate block
        getSharedState.candidateBlock = null

        return {
            success: true,
            block,
            proVotes: signatureCount,
            conVotes: con,
            threshold,
        }
    }

    log.error(
        `[PetriBlockFinalizer] Block #${blockNumber} FAILED threshold ` +
        `(${signatureCount}/${threshold}). Skipping block.`,
    )

    getSharedState.candidateBlock = null

    return {
        success: false,
        block,
        proVotes: signatureCount,
        conVotes: con,
        threshold,
    }
}

/**
 * Non-secretary path: do nothing during finalization.
 *
 * The member's verify-then-sign happens passively when the secretary
 * calls broadcastBlockHash, which triggers manageProposeBlockHash on
 * this node. The finalized block arrives via BroadcastManager sync.
 */
async function memberFinalize(
    block: Block,
    shard: Peer[],
    _totalMembers: number,
    threshold: number,
): Promise<FinalizationResult> {
    const blockNumber = block.number

    log.info(
        `[PetriBlockFinalizer] We are MEMBER for block #${blockNumber}. ` +
        "Waiting for secretary broadcast.",
    )

    // Set candidate block so manageProposeBlockHash can verify against it
    getSharedState.candidateBlock = block

    // Wait for the finalized block to arrive via BroadcastManager.
    // The secretary will: broadcastBlockHash (we sign) → insertBlock → broadcastNewBlock.
    // We need the finalized block inserted before starting the next round.
    const waitMs = 15_000 // max wait (block interval + margin)
    const pollMs = 200
    const deadline = Date.now() + waitMs

    while (Date.now() < deadline) {
        const lastBlockNum = getSharedState.lastBlockNumber
        if (lastBlockNum >= blockNumber) {
            log.info(
                `[PetriBlockFinalizer] Member: block #${blockNumber} arrived via sync`,
            )
            getSharedState.candidateBlock = null
            return {
                success: true,
                block,
                proVotes: 1,
                conVotes: 0,
                threshold,
            }
        }
        await new Promise(r => setTimeout(r, pollMs))
    }

    log.warn(
        `[PetriBlockFinalizer] Member: block #${blockNumber} did NOT arrive within ${waitMs}ms`,
    )
    getSharedState.candidateBlock = null

    return {
        success: false,
        block,
        proVotes: 0,
        conVotes: 0,
        threshold,
    }
}
