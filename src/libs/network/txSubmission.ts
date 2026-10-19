import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import Mempool from "src/libs/blockchain/mempool"
import { isWithinDeepWindow } from "src/libs/blockchain/referenceBlockWindow"
import GossipManager from "src/libs/gossip/GossipManager"
import { estimateNextConfirmationBlock } from "src/libs/consensus/confirmationEstimate"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

export interface TxSubmissionResult {
    ok: boolean
    confirmationBlock?: number
    error?: string
    /** False when the tx sits only in our mempool and a publish is pending. */
    published?: boolean
}

export const UNPUBLISHED_MAX = 1000

// Envelopes the mesh has not taken yet, by tx hash. Retried from the
// gossip heights tick until published or until the reference window
// closes on them.
const unpublished = new Map<string, ValidityData>()

export function unpublishedCount(): number {
    return unpublished.size
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetUnpublished(): void {
    unpublished.clear()
}

async function tryPublish(validityData: ValidityData): Promise<boolean> {
    if (!GossipManager.isEnabled()) return false
    try {
        return await GossipManager.getInstance().publishTx(validityData)
    } catch (e) {
        log.warning(
            `[TX SUBMIT] gossip publish of ${validityData.data.transaction.hash} failed: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        return false
    }
}

function holdForRetry(validityData: ValidityData): void {
    const hash = validityData.data.transaction.hash
    if (unpublished.size >= UNPUBLISHED_MAX && !unpublished.has(hash)) {
        const oldest = unpublished.keys().next().value
        unpublished.delete(oldest)
        log.warning(
            `[TX SUBMIT] unpublished queue full; dropping ${oldest} to hold ${hash}`,
        )
    }
    unpublished.set(hash, validityData)
}

/**
 * Re-offers held envelopes to the mesh. Called from the gossip heights
 * tick, so a sidecar that was down at submit time gets the tx as soon as
 * it is back. Entries whose reference block left the deep window are
 * dropped: no committee would admit them any more.
 */
export async function retryUnpublishedTxs(): Promise<void> {
    if (unpublished.size === 0) return
    const head = getSharedState.lastBlockNumber ?? 0
    for (const [hash, validityData] of [...unpublished]) {
        if (!isWithinDeepWindow(validityData.data.reference_block, head)) {
            unpublished.delete(hash)
            log.warning(
                `[TX SUBMIT] ${hash} expired before the mesh took it (reference block ${validityData.data.reference_block}, head ${head})`,
            )
            continue
        }
        if (await tryPublish(validityData)) {
            unpublished.delete(hash)
            log.info(`[TX SUBMIT] ${hash} published after retry`)
        }
    }
}

/**
 * The one way a validated transaction enters the network: into this
 * node's own mempool, then onto the tx topic for every other staked node.
 * Used by RPC intake and by the L2PS hash service.
 *
 * The publish has no ack; receivers dedup on the tx hash and the per-block
 * mempool merge repairs anything the mesh dropped between committee
 * members. A publish that cannot happen now (sidecar down, not staked yet)
 * is held and retried, since a tx known only to a node outside the
 * committee reaches no block otherwise. The returned block number is an
 * estimate.
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

    const published = await tryPublish(validityData)
    if (!published) {
        holdForRetry(validityData)
        log.warning(
            `[TX SUBMIT] ${transaction.hash} is in our mempool but not yet on the mesh; will retry (${unpublished.size} held)`,
        )
    }

    return {
        ok: true,
        published,
        confirmationBlock: await estimateNextConfirmationBlock(),
    }
}
