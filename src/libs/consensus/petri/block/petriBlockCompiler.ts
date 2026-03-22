/**
 * PetriBlockCompiler — Petri Consensus Phase 3
 *
 * Compiles mempool transactions into a candidate block at the 10s boundary.
 * Reuses existing block creation infrastructure:
 *   - orderTransactions() for deterministic ordering
 *   - createBlock() for block assembly, signing, and next-proposer calculation
 *
 * REVIEW: Petri classifications (PRE_APPROVED, PROBLEMATIC) are informational —
 * they drive soft finality reporting but do NOT gate block inclusion. All mempool
 * transactions are included to ensure deterministic block contents across nodes,
 * preventing BFT vote disagreements caused by per-node delta agreement divergence.
 */

import type { Peer } from "@/libs/peer"
import type Block from "@/libs/blockchain/block"
import { Transaction } from "@kynesyslabs/demosdk/types"
import Mempool from "@/libs/blockchain/mempool_v2"
import { orderTransactions } from "@/libs/consensus/v2/routines/orderTransactions"
import { createBlock } from "@/libs/consensus/v2/routines/createBlock"
import getCommonValidatorSeed from "@/libs/consensus/v2/routines/getCommonValidatorSeed"
import Chain from "@/libs/blockchain/chain"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"

export interface CompilationResult {
    block: Block | null
    /** Transaction hashes included in the block */
    includedTxHashes: string[]
    /** Whether the block has any transactions (empty blocks are valid) */
    isEmpty: boolean
}

/**
 * Compile all mempool transactions into a candidate block.
 *
 * All transactions are included regardless of Petri classification to ensure
 * deterministic block contents across nodes. Classification remains informational
 * for soft finality tracking.
 *
 * @param shard - The current shard members
 * @param resolvedTxs - Additional transactions resolved from BFT arbitration
 * @returns CompilationResult with the candidate block
 */
export async function compileBlock(
    shard: Peer[],
    resolvedTxs: Transaction[] = [],
): Promise<CompilationResult> {
    log.info("[PetriBlockCompiler] Starting block compilation")

    // Step 1: Get ALL mempool transactions (classification is informational only)
    const mempoolTxs = await Mempool.getMempool()

    // REVIEW: Apply a deterministic timestamp cutoff so all nodes compile the
    // same TX set. TXs arriving in the last forge interval (2s) may not have
    // propagated to all nodes yet — defer them to the next block.
    const blockIntervalMs = getSharedState.petriConfig?.blockIntervalMs ?? 10000
    const forgeIntervalMs = getSharedState.petriConfig?.forgeIntervalMs ?? 2000
    const blockIntervalSec = Math.floor(blockIntervalMs / 1000)
    // currentUTCTime is in seconds; block boundary and cutoff in ms for TX comparison
    const blockBoundaryMs =
        Math.floor(getSharedState.currentUTCTime / blockIntervalSec) * blockIntervalSec * 1000
    const txCutoffMs = blockBoundaryMs - forgeIntervalMs

    const filteredMempoolTxs = mempoolTxs.filter(tx => Number(tx.timestamp) <= txCutoffMs)
    if (filteredMempoolTxs.length < mempoolTxs.length) {
        log.info(
            `[PetriBlockCompiler] Deferred ${mempoolTxs.length - filteredMempoolTxs.length} ` +
            `late TXs (cutoff=${txCutoffMs})`,
        )
    }

    // Combine mempool txs with any resolved txs from arbitration
    const allTxs: Transaction[] = [
        ...(filteredMempoolTxs as unknown as Transaction[]),
        ...resolvedTxs,
    ]

    const includedTxHashes = allTxs.map(tx => tx.hash)

    if (allTxs.length === 0) {
        log.info("[PetriBlockCompiler] No transactions to include — empty block")
        // Empty blocks are valid in Petri — block production continues on schedule
    }

    // Step 2: Order transactions deterministically (by timestamp)
    const ordered = await orderTransactions({ transactions: allTxs })

    // Step 3: Get block metadata
    const lastBlock = await Chain.getLastBlock()
    const { commonValidatorSeed } = await getCommonValidatorSeed(lastBlock)
    const previousBlockHash = lastBlock.hash
    const blockNumber = lastBlock.number + 1

    // Step 4: Set consensus timestamp for block creation.
    // REVIEW: Quantize to the blockInterval boundary so all nodes produce the
    // same timestamp regardless of minor wall-clock drift. This is critical for
    // deterministic block hashes across the shard.
    const now = getSharedState.currentUTCTime
    getSharedState.lastConsensusTime =
        Math.floor(now / blockIntervalSec) * blockIntervalSec

    // Step 5: Clear any stale candidate block before creating new one
    getSharedState.candidateBlock = null

    // Step 6: Create the block (signs it, calculates next proposer)
    const block = await createBlock(
        ordered,
        commonValidatorSeed,
        previousBlockHash,
        blockNumber,
        [], // Peerlist — empty per existing convention
    )

    log.info(
        `[PetriBlockCompiler] Block #${blockNumber} compiled: ` +
        `${ordered.length} txs, hash=${block.hash.substring(0, 16)}...`,
    )

    return {
        block,
        includedTxHashes,
        isEmpty: ordered.length === 0,
    }
}

/**
 * Clean up mempool after block finalization.
 * Removes PROBLEMATIC transactions that were rejected by BFT.
 *
 * @param rejectedTxHashes - Hashes of rejected PROBLEMATIC transactions
 */
export async function cleanRejectedFromMempool(
    rejectedTxHashes: string[],
): Promise<void> {
    for (const hash of rejectedTxHashes) {
        try {
            await Mempool.removeTransaction(hash)
        } catch (error) {
            log.warn(
                `[PetriBlockCompiler] Failed to remove rejected tx ${hash.substring(0, 16)}...: ${error}`,
            )
        }
    }

    if (rejectedTxHashes.length > 0) {
        log.info(
            `[PetriBlockCompiler] Cleaned ${rejectedTxHashes.length} rejected txs from mempool`,
        )
    }
}
