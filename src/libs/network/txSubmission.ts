import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import Mempool from "src/libs/blockchain/mempool"
import GossipManager from "src/libs/gossip/GossipManager"
import { estimateNextConfirmationBlock } from "src/libs/consensus/confirmationEstimate"
import log from "src/utilities/logger"

export interface TxSubmissionResult {
    ok: boolean
    confirmationBlock?: number
    error?: string
}

/**
 * The one way a validated transaction enters the network: into this
 * node's own mempool, then onto the tx topic for every other staked node.
 * Used by RPC intake and by the L2PS hash service.
 *
 * The publish is fire-and-forget. There is no ack and no retry; receivers
 * dedup on the tx hash and the per-block mempool merge repairs anything
 * the mesh dropped. The returned block number is an estimate.
 */
export async function submitValidatedTx(
    validityData: ValidityData,
    transaction: Transaction = validityData.data.transaction,
): Promise<TxSubmissionResult> {
    const { error } = await Mempool.addTransactionWithLock({
        ...transaction,
        reference_block: validityData.data.reference_block,
    })
    if (error) {
        return { ok: false, error }
    }

    if (GossipManager.isEnabled()) {
        GossipManager.getInstance()
            .publishTx(validityData)
            .catch(e =>
                log.warning(
                    `[TX SUBMIT] gossip publish of ${transaction.hash} failed: ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                ),
            )
    }

    return { ok: true, confirmationBlock: await estimateNextConfirmationBlock() }
}
