import type Transaction from "src/libs/blockchain/transaction"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import GCR from "@/libs/blockchain/gcr/gcr"
import { normalizeAccount } from "@/libs/l2ps/editConservation"
import {
    deepWindowCutoff,
    isReferenceBlockAllowed,
} from "@/libs/blockchain/referenceBlockWindow"
import { TRANSACTION_STATUS } from "@/utilities/constants"
import { ErrorCode } from "@/errors"

export interface FailedTranscation {
    txhash: string
    code: ErrorCode
    message: string
    attrs?: Record<string, any> | null
}

export type MempoolTransaction = Transaction & { reference_block: number }

/**
 * Filter mempool transactions by reference block.
 *
 * When `includeExpiredAsFailed` is false: removes transactions that will
 * fail because the reference block is out of range.
 *
 * With `includeExpiredAsFailed`: expired txs still inside the deep window
 * (5x referenceBlockRoom) are marked FAILED and kept in `validTxs` so
 * they enter the block as failed — mirroring the TX_NONCE_INVALID_LOW
 * pattern. Txs older than the deep window, and txs whose reference block
 * is in the future, are removed as before; the merge admission path
 * applies the same bounds, so every shard member sees an identical set.
 *
 * @param mempool - The mempool transactions
 * @param includeExpiredAsFailed - Enable the include-as-failed path
 * @returns The valid and failed transactions
 */
export function filterMempoolByRefBlock(
    mempool: MempoolTransaction[],
    includeExpiredAsFailed = false,
) {
    // map of failed tx hashes and their reason
    const failedTxs: Array<FailedTranscation> = []
    const validTxs: MempoolTransaction[] = []
    const lastBlockNumber = getSharedState.lastBlockNumber

    for (const tx of mempool) {
        if (!isReferenceBlockAllowed(tx.reference_block, lastBlockNumber)) {
            const code = ErrorCode.TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE
            const message = `Reference block expired. Expected: ${lastBlockNumber - getSharedState.referenceBlockRoom} - ${lastBlockNumber} got ${tx.reference_block}`
            if (
                includeExpiredAsFailed &&
                tx.reference_block <= lastBlockNumber &&
                tx.reference_block >= deepWindowCutoff(lastBlockNumber)
            ) {
                tx.status = TRANSACTION_STATUS.FAILED
                tx.attrs = {
                    code,
                    message,
                    reference_block: tx.reference_block,
                }
                validTxs.push(tx)
                log.debug(
                    `[TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE] including tx as failed: ${tx.hash}`,
                )
            } else {
                failedTxs.push({ txhash: tx.hash, code, message })
            }
        } else {
            validTxs.push(tx)
        }
    }

    return { validTxs, failedTxs }
}

/**
 * Filter mempool transactions by valid nonce. Removes transactions that will fail
 * because the previous transaction changed the nonce of an account in the next transaction.
 *
 * @param mempool - The sorted mempool transactions
 *
 * @returns The filtered mempool transactions
 *  */
export async function filterMempoolByNonce(mempool: MempoolTransaction[]) {
    log.debug("[filterMempoolByValidNonce] Filtering mempool by valid nonce")
    log.debug(
        "[filterMempoolByValidNonce] Initial mempool length: " + mempool.length,
    )
    const validTxs: MempoolTransaction[] = []
    const failedTxs: Array<FailedTranscation> = []
    const nonceAccounts = new Set<string>()

    for (const tx of mempool) {
        for (const edit of tx.content.gcr_edits) {
            if (edit.type === "nonce") {
                nonceAccounts.add(normalizeAccount(edit.account))
            }
        }
    }

    log.debug(
        "[filterMempoolByValidNonce] Found " +
            nonceAccounts.size +
            " Nonce accounts",
    )

    // fetch all nonce counts from the db
    const nonces = await GCR.getAccountNonces(Array.from(nonceAccounts))
    const startFilterNonces = { ...nonces }

    txLoop: for (const tx of mempool) {
        // Already marked failed upstream (expired ref block): keep it for
        // block inclusion without letting it consume a nonce slot — its
        // edits are never applied.
        if (tx.status === TRANSACTION_STATUS.FAILED) {
            validTxs.push(tx)
            continue txLoop
        }

        const nonceEdits = tx.content.gcr_edits.filter(e => e.type === "nonce")

        if (nonceEdits.length === 0) {
            validTxs.push(tx)
            continue txLoop
        }

        for (const edit of nonceEdits) {
            const acct = normalizeAccount(edit.account)
            const expected = nonces[acct] + 1

            if (tx.content.nonce === expected) {
                validTxs.push(tx)
                nonces[acct]++
                continue txLoop
            } else if (tx.content.nonce < expected) {
                // Update the transaction status as failed, but include in block
                tx.status = TRANSACTION_STATUS.FAILED
                tx.attrs = {
                    code: ErrorCode.TX_NONCE_INVALID_LOW,
                    message: `Invalid nonce edit. Expected ${expected}, got ${tx.content.nonce}`,
                    reference_block: tx.reference_block,
                }
                validTxs.push(tx)

                log.debug(
                    `[TX_NONCE_INVALID_LOW] including tx as failed: ${tx.hash}: invalid nonce edit`,
                )
                log.debug(
                    "[TX_NONCE_INVALID_LOW] Invalid nonce edit for account: " +
                        acct,
                )
                log.debug(
                    `[TX_NONCE_INVALID_LOW] Expected ${expected}, got ${tx.content.nonce}`,
                )
            } else {
                failedTxs.push({
                    txhash: tx.hash,
                    code: ErrorCode.TX_NONCE_INVALID_HIGH,
                    message: `Invalid nonce edit. Expected ${expected}, got ${tx.content.nonce}`,
                })

                log.debug(`[TX_NONCE_INVALID_HIGH] keeping tx: ${tx.hash}`)
                log.debug(
                    "[TX_NONCE_INVALID_HIGH] Invalid nonce edit for account: " +
                        acct,
                )
                log.debug(
                    `[TX_NONCE_INVALID_HIGH] Expected ${expected}, got ${tx.content.nonce}`,
                )
            }
        }
    }

    log.debug(
        "[filterMempoolByValidNonce] Final mempool length: " + validTxs.length,
    )

    return {
        validTxs,
        failedTxs,
        nonceAccounts,
        startFilterNonces,
        projectedEndNonces: nonces,
    }
}
