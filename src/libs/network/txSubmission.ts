import type { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Mempool from "src/libs/blockchain/mempool"
import {
    isWithinDeepWindow,
    signedReferenceBlock,
} from "src/libs/blockchain/referenceBlockWindow"
import GossipManager from "src/libs/gossip/GossipManager"
import { TXS_MAX_BYTES } from "src/libs/gossip/topics"
import { estimateNextConfirmationBlock } from "src/libs/consensus/confirmationEstimate"
import { verifyRpcEdits } from "src/libs/blockchain/validation/editBinding"
import { clientTxTypeRefusal } from "src/libs/blockchain/validation/txTypes"
import { nftGatingAtTip } from "@/forks/nftValidatorGatingGate"
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
// gossip heights tick until published, until they leave our mempool, or
// until the reference window closes on them.
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
 * Why the tx topic cannot carry `validityData`, or null. Measured as the
 * publish encodes it and as the topic validator counts it. Every staked peer
 * refuses a larger message, so the tx would reach a block only while this
 * node sat in the committee, and would otherwise leave the pool unannounced
 * once its reference block expired.
 */
export function gossipSizeRefusal(validityData: ValidityData): string | null {
    const bytes = Buffer.byteLength(JSON.stringify(validityData))
    return bytes > TXS_MAX_BYTES
        ? `Transaction envelope is ${bytes} bytes, over the tx gossip limit of ${TXS_MAX_BYTES}: peers would not receive it`
        : null
}

/**
 * False once a held tx has left our mempool: a block included it, or the
 * pool removed it (age, eviction, failed execution). A failed lookup
 * keeps it: re-offering an included tx is harmless, receivers dedup it.
 */
async function stillPending(hash: string): Promise<boolean> {
    try {
        if (await Mempool.checkTransactionByHash(hash)) return true
        if (await Chain.checkTxExists(hash)) {
            log.debug(`[TX SUBMIT] ${hash} is on chain; no longer held`)
        } else {
            log.warning(
                `[TX SUBMIT] ${hash} left our mempool without reaching the chain (expired, evicted or failed); no longer held`,
            )
        }
        return false
    } catch (e) {
        log.debug(
            `[TX SUBMIT] lookup of held ${hash} failed; offering it anyway: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        return true
    }
}

/**
 * Re-offers held envelopes to the mesh. Called from the gossip heights
 * tick, so a sidecar that was down at submit time gets the tx as soon as
 * it is back. Entries whose reference block left the deep window are
 * dropped: no committee would admit them any more. So are entries no
 * longer in our mempool: a block included them (we may be the only
 * staked node) or the pool removed them.
 */
export async function retryUnpublishedTxs(): Promise<void> {
    if (unpublished.size === 0) return
    const head = getSharedState.lastBlockNumber ?? 0
    for (const [hash, validityData] of [...unpublished]) {
        const reference = signedReferenceBlock(validityData.data.transaction)
        if (reference === null || !isWithinDeepWindow(reference, head)) {
            unpublished.delete(hash)
            log.warning(
                `[TX SUBMIT] ${hash} expired before the mesh took it (reference block ${reference}, head ${head})`,
            )
            continue
        }
        if (!(await stillPending(hash))) {
            unpublished.delete(hash)
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
 * members. A publish that cannot happen now (sidecar down, not staked yet,
 * no peer on the tx topic) is held and retried, since a tx known only to a
 * node outside the committee reaches no block otherwise. For the same
 * reason, with gossip on, a tx too large for the topic ever to carry is
 * refused, not queued. The returned block number is an estimate.
 */
export async function submitValidatedTx(
    validityData: ValidityData,
    transaction: Transaction = validityData.data.transaction,
): Promise<TxSubmissionResult> {
    const typeRefusal = clientTxTypeRefusal(transaction, nftGatingAtTip())
    if (typeRefusal) {
        log.error(`[TX SUBMIT] refusing ${transaction.hash}: ${typeRefusal}`)
        return { ok: false, error: typeRefusal }
    }

    const sizeRefusal = GossipManager.isEnabled()
        ? gossipSizeRefusal(validityData)
        : null
    if (sizeRefusal) {
        log.error(`[TX SUBMIT] refusing ${transaction.hash}: ${sizeRefusal}`)
        return { ok: false, error: sizeRefusal }
    }

    const edits = await verifyRpcEdits(transaction)
    if (!edits.ok) {
        log.error(`[TX SUBMIT] refusing ${transaction.hash}: ${edits.reason}`)
        return { ok: false, error: edits.reason }
    }

    const { error } = await Mempool.addTransactionWithLock(
        // The pool takes the reference block from the signed content.
        transaction as typeof transaction & { reference_block: number },
        undefined,
        { origin: "rpc" },
    )
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
