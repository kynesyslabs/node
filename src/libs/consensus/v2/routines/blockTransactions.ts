import {
    filterMempoolByNonce,
    filterMempoolByRefBlock,
    type FailedTranscation,
    type MempoolTransaction,
} from "./mempoolFilters"
import { DEFAULT_BLOCK_CAPS, selectBlockTransactions, type BlockCaps } from "./blockCaps"

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
    const ref = filterMempoolByRefBlock(merged, true)
    const nonce = await filterMempoolByNonce(ref.validTxs)
    const failedTxs = [...ref.failedTxs, ...nonce.failedTxs]
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
