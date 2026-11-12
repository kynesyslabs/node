import {
    filterMempoolByNonce,
    filterMempoolByRefBlock,
    type FailedTranscation,
    type MempoolTransaction,
} from "./mempoolFilters"
import { DEFAULT_BLOCK_CAPS, selectBlockTransactions, type BlockCaps } from "./blockCaps"
import { pqcTxsRefusedAt } from "@/libs/blockchain/validation/txSignatureRules"
import { IdentityPrefetchError } from "@/libs/blockchain/validation/identityPrefetchError"
import { ErrorCode } from "@/errors"
import log from "src/utilities/logger"

export interface BlockTransactions {
    txs: MempoolTransaction[]
    failedTxs: FailedTranscation[]
    nonce: Awaited<ReturnType<typeof filterMempoolByNonce>>
}

export interface BlockCapsOptions {
    /** Whether `blockCaps` is active at the block's height. */
    capped: boolean
    osDenominationActive: boolean
    caps?: BlockCaps
}

/**
 * The txs block `height` carries from the merged pool, judged by the
 * reference-block and nonce filters, and those the filters fail.
 *
 * Under `blockCaps` the share is chosen among the txs the filters let in,
 * so a tx waiting on a missing nonce does not take a slot from a ready one.
 * The choice is then judged again on its own, so the nonce projections
 * describe exactly the block. Both passes depend only on the pool and the
 * chain state, so every member holding the same pool forges the same block.
 */
export async function judgeBlockTransactions(
    merged: MempoolTransaction[],
    height: number,
    options: BlockCapsOptions,
): Promise<BlockTransactions> {
    const identity = await leaveOutRefusedPqcTxs(merged, height)
    const ref = filterMempoolByRefBlock(identity.kept, true)
    const nonce = await filterMempoolByNonce(ref.validTxs)
    const failedTxs = [...identity.failedTxs, ...ref.failedTxs, ...nonce.failedTxs]
    if (!options.capped) {
        return { txs: nonce.validTxs, failedTxs, nonce }
    }

    const selected = selectBlockTransactions(
        nonce.validTxs,
        height,
        options.osDenominationActive,
        options.caps ?? DEFAULT_BLOCK_CAPS,
    )
    if (selected.length === nonce.validTxs.length) {
        return { txs: nonce.validTxs, failedTxs, nonce }
    }
    // Each sender keeps a prefix of its admitted txs, so none changes verdict.
    const selectedRef = filterMempoolByRefBlock(selected, true)
    const selectedNonce = await filterMempoolByNonce(selectedRef.validTxs)
    return {
        txs: selectedNonce.validTxs,
        failedTxs: [
            ...failedTxs,
            ...selectedRef.failedTxs,
            ...selectedNonce.failedTxs,
        ],
        nonce: selectedNonce,
    }
}

/**
 * Leaves out the PQC-only txs whose identity record is gone from the state
 * block `height` is built on. Admission judged them against the record as it
 * was then; a `pqcremove` in an earlier block deletes it, and a node syncing
 * this block would refuse it for that. Failed as well as applied txs are
 * judged, since Sync checks the signature of every tx a block lists. A tx
 * the validator could not judge is left out unfailed, for a later block.
 *
 * @throws IdentityPrefetchError when the identity records cannot be read.
 *   Every PQC-only tx would then be undecided, and a block forged without
 *   them differs from the one the members that read the records forge, so
 *   the round's catch takes it as a failed state read: the member sits the
 *   round out and prevotes nothing.
 */
export async function leaveOutRefusedPqcTxs(
    txs: MempoolTransaction[],
    height: number,
): Promise<{ kept: MempoolTransaction[]; failedTxs: FailedTranscation[] }> {
    let verdicts: Awaited<ReturnType<typeof pqcTxsRefusedAt>>
    try {
        verdicts = await pqcTxsRefusedAt(height, txs as never)
    } catch (error) {
        if (error instanceof IdentityPrefetchError) {
            log.error(
                `[consensusRoutine] Cannot judge the PQC-only txs for block ${height}, sitting the round out: ${error.message}`,
            )
        }
        throw error
    }
    const { refused, undecided } = verdicts
    if (refused.size === 0 && undecided.size === 0) return { kept: txs, failedTxs: [] }
    const failedTxs: FailedTranscation[] = []
    for (const [txhash, reason] of refused) {
        failedTxs.push({ txhash, code: ErrorCode.VALIDATION_TX_INVALID, message: reason })
    }
    return {
        kept: txs.filter(tx => !refused.has(tx.hash) && !undecided.has(tx.hash)),
        failedTxs,
    }
}
