/**
 * TransactionFinality — Petri Consensus Phase 5
 *
 * Provides dual finality model for transactions:
 * - Soft finality: timestamp when tx was classified PRE_APPROVED (~2s)
 * - Hard finality: timestamp when tx was included in a confirmed block (~12s)
 *
 * Queries both mempool (pending txs) and chain (confirmed txs).
 */

import Mempool from "@/libs/blockchain/mempool_v2"
import { getTxByHash } from "@/libs/blockchain/chainTransactions"
import Datasource from "@/model/datasource"
import { Transactions } from "@/model/entities/Transactions"
import log from "@/utilities/logger"

export interface TransactionFinalityResult {
    /** Transaction hash queried */
    hash: string
    /** Classification: PRE_APPROVED, TO_APPROVE, PROBLEMATIC, or UNKNOWN */
    classification: string
    /** Soft finality timestamp (when PRE_APPROVED), null if not yet reached */
    softFinalityAt: number | null
    /** Hard finality timestamp (when included in block), null if not yet confirmed */
    hardFinalityAt: number | null
    /** Whether the transaction is confirmed in a block */
    confirmed: boolean
}

/**
 * Get the finality status of a transaction.
 * Checks both mempool (pending) and chain (confirmed).
 *
 * @param txHash - The transaction hash to query
 * @returns TransactionFinalityResult with soft/hard finality timestamps
 */
export async function getTransactionFinality(
    txHash: string,
): Promise<TransactionFinalityResult> {
    const result: TransactionFinalityResult = {
        hash: txHash,
        classification: "UNKNOWN",
        softFinalityAt: null,
        hardFinalityAt: null,
        confirmed: false,
    }

    try {
        // Step 1: Check confirmed transactions (chain)
        const confirmedTx = await getTxByHash(txHash)
        if (confirmedTx) {
            result.confirmed = true
            result.classification = "PRE_APPROVED" // Confirmed txs were PRE_APPROVED
            result.hardFinalityAt = Number(confirmedTx.content?.timestamp ?? 0)

            // Check if soft_finality_at was persisted in the Transactions entity
            const db = await Datasource.getInstance()
            const txRepo = db.getDataSource().getRepository(Transactions)
            const txEntity = await txRepo.findOne({ where: { hash: txHash } })
            if (txEntity?.soft_finality_at) {
                result.softFinalityAt = Number(txEntity.soft_finality_at)
            }

            return result
        }

        // Step 2: Check mempool (pending)
        const mempoolTxs = await Mempool.getTransactionsByHashes([txHash])
        if (mempoolTxs.length > 0) {
            const mempoolTx = mempoolTxs[0]
            result.classification = mempoolTx.classification ?? "UNKNOWN"

            if (mempoolTx.soft_finality_at) {
                result.softFinalityAt = Number(mempoolTx.soft_finality_at)
            }

            return result
        }

        // Not found anywhere
        return result
    } catch (error) {
        log.error(`[TransactionFinality] Error querying tx ${txHash.substring(0, 16)}...: ${error}`)
        return result
    }
}
