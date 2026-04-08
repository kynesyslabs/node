/**
 * BFTArbitrator — Petri Consensus Phase 3
 *
 * Handles PROBLEMATIC transactions (delta disagreement) via a single BFT round.
 * This is Petri's "exception handler" — BFT only runs for conflicting txs,
 * not for the majority of transactions.
 *
 * For each PROBLEMATIC tx:
 *   1. Re-execute speculatively to get our fresh delta
 *   2. Exchange deltas with shard (one final round)
 *   3. If 2/3+1 agree → resolved (include in block)
 *   4. If not → rejected (remove from mempool, error to sender)
 *
 * The chain NEVER stalls — rejection is the fail-safe.
 */

import type { Peer } from "@/libs/peer"
import { Transaction } from "@kynesyslabs/demosdk/types"
import Mempool from "@/libs/blockchain/mempool_v2"
import { TransactionClassification } from "@/libs/consensus/petri/types/classificationTypes"
import { executeSpeculatively } from "@/libs/consensus/petri/execution/speculativeExecutor"
import { classifyTransaction } from "@/libs/consensus/petri/classifier/transactionClassifier"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"

export interface ArbitrationResult {
    /** Transactions that reached BFT agreement — include in block */
    resolved: Transaction[]
    /** Transaction hashes that failed BFT — remove from mempool */
    rejectedHashes: string[]
}

/**
 * Run BFT arbitration on all PROBLEMATIC transactions in the mempool.
 *
 * @param shard - Current shard members
 * @returns ArbitrationResult with resolved and rejected lists
 */
export async function arbitrate(
    shard: Peer[],
): Promise<ArbitrationResult> {
    const problematicMempoolTxs = await Mempool.getByClassification(
        TransactionClassification.PROBLEMATIC,
    )

    if (problematicMempoolTxs.length === 0) {
        return { resolved: [], rejectedHashes: [] }
    }

    log.info(
        `[BFTArbitrator] Arbitrating ${problematicMempoolTxs.length} PROBLEMATIC transactions`,
    )

    const resolved: Transaction[] = []
    const rejectedHashes: string[] = []
    const ourKey = getSharedState.publicKeyHex
    const peers = shard.filter(p => p.identity !== ourKey)
    // BFT threshold: floor(2n/3) + 1
    const totalMembers = shard.length + 1 // +1 for self
    const bftThreshold = Math.floor((totalMembers * 2) / 3) + 1

    for (const mempoolTx of problematicMempoolTxs) {
        const tx = mempoolTx as unknown as Transaction
        const txHashShort = tx.hash.substring(0, 16)

        try {
            // Step 1: Re-execute speculatively to get our fresh delta
            const classResult = await classifyTransaction(tx)
            const specResult = await executeSpeculatively(tx, classResult.gcrEdits)

            if (!specResult.success || !specResult.delta) {
                log.warn(
                    `[BFTArbitrator] Speculative execution failed for ${txHashShort}... — rejecting`,
                )
                rejectedHashes.push(tx.hash)
                continue
            }

            const ourDelta = specResult.delta.hash

            // Step 2: Request fresh delta from each shard member
            // REVIEW: Reuses petri_exchangeDeltas RPC with roundNumber: -1 as sentinel
            // to indicate this is a BFT arbitration request, not a regular forge exchange.
            // The handler returns local deltas regardless of roundNumber, so this works
            // correctly. Consider a dedicated RPC method if arbitration logic diverges.
            let agreeCount = 1 // We agree with ourselves

            const deltaRequests = peers.map(async peer => {
                try {
                    const response = await peer.longCall(
                        {
                            method: "consensus_routine",
                            params: [{
                                method: "petri_exchangeDeltas",
                                params: [{ roundNumber: -1, deltas: { [tx.hash]: ourDelta } }],
                            }],
                        },
                        true,
                        { sleepTime: 250, retries: 1 },
                    )

                    if (response.result === 200 && response.response) {
                        const data = response.response as { deltas?: Record<string, string> }
                        if (data.deltas?.[tx.hash] === ourDelta) {
                            return true // Agrees
                        }
                    }
                    return false
                } catch {
                    return false
                }
            })

            const results = await Promise.all(deltaRequests)
            agreeCount += results.filter(Boolean).length

            // Step 3: Check BFT threshold
            if (agreeCount >= bftThreshold) {
                log.info(
                    `[BFTArbitrator] TX ${txHashShort}... RESOLVED: ${agreeCount}/${totalMembers} agree (threshold=${bftThreshold})`,
                )
                // Promote to PRE_APPROVED so it gets included in block
                await Mempool.updateClassification(
                    tx.hash,
                    TransactionClassification.PRE_APPROVED,
                    ourDelta,
                )
                resolved.push(tx)
            } else {
                log.info(
                    `[BFTArbitrator] TX ${txHashShort}... REJECTED: ${agreeCount}/${totalMembers} agree (threshold=${bftThreshold})`,
                )
                rejectedHashes.push(tx.hash)
            }
        } catch (error) {
            log.error(
                `[BFTArbitrator] Error arbitrating tx ${txHashShort}...: ${error}`,
            )
            // On error, reject — chain never stalls
            rejectedHashes.push(tx.hash)
        }
    }

    log.info(
        `[BFTArbitrator] Arbitration complete: ${resolved.length} resolved, ${rejectedHashes.length} rejected`,
    )

    return { resolved, rejectedHashes }
}
