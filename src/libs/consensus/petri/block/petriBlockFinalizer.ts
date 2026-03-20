/**
 * PetriBlockFinalizer — Petri Consensus Phase 3
 *
 * Finalizes a compiled block by:
 *   1. Broadcasting block hash to shard for BFT voting
 *   2. Checking BFT threshold (floor(2n/3) + 1 signatures)
 *   3. Inserting the block into the chain
 *   4. Broadcasting the finalized block to the network
 *
 * Reuses existing infrastructure:
 *   - broadcastBlockHash() for shard voting
 *   - isBlockValid() threshold logic (inlined — same formula)
 *   - insertBlock() for chain persistence
 *   - BroadcastManager.broadcastNewBlock() for network propagation
 */

import type { Peer } from "@/libs/peer"
import type Block from "@/libs/blockchain/block"
import { broadcastBlockHash } from "@/libs/consensus/v2/routines/broadcastBlockHash"
import { insertBlock } from "@/libs/blockchain/chainBlocks"
import { BroadcastManager } from "@/libs/communications/broadcastManager"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"

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
 * BFT threshold check — same formula as PoRBFT v2 isBlockValid().
 * Requires floor(2n/3) + 1 signatures for block validity.
 */
function isBlockValid(pro: number, totalVotes: number): boolean {
    const threshold = Math.floor((totalVotes * 2) / 3) + 1
    return pro >= threshold
}

/**
 * Finalize a compiled block: vote, validate, insert, broadcast.
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

    log.info(`[PetriBlockFinalizer] Finalizing block #${blockNumber} (${hashShort}...)`)

    // Step 1: Broadcast block hash to shard for BFT voting
    const [pro, con] = await broadcastBlockHash(block, shard)
    const totalMembers = shard.length + 1 // +1 for our own signature (already in block)
    const threshold = Math.floor((totalMembers * 2) / 3) + 1

    log.info(
        `[PetriBlockFinalizer] Block #${blockNumber} votes: ${pro} pro, ${con} con ` +
        `(threshold=${threshold}, total=${totalMembers})`,
    )

    // Step 2: Check BFT validity
    if (!isBlockValid(pro, totalMembers)) {
        log.error(
            `[PetriBlockFinalizer] Block #${blockNumber} INVALID — ` +
            `${pro}/${totalMembers} signatures (need ${threshold})`,
        )

        // Clear the candidate block
        getSharedState.candidateBlock = null

        return {
            success: false,
            block,
            proVotes: pro,
            conVotes: con,
            threshold,
        }
    }

    log.info(
        `[PetriBlockFinalizer] Block #${blockNumber} VALID — inserting into chain`,
    )

    // Step 3: Insert block into chain (atomic DB transaction)
    await insertBlock(block)

    // Step 4: Broadcast finalized block to non-shard peers
    await BroadcastManager.broadcastNewBlock(block)

    // Step 5: Clear candidate block
    getSharedState.candidateBlock = null

    log.info(`[PetriBlockFinalizer] Block #${blockNumber} finalized and broadcast`)

    return {
        success: true,
        block,
        proVotes: pro,
        conVotes: con,
        threshold,
    }
}
