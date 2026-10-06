import type { Transaction as SdkTransaction } from "@kynesyslabs/demosdk/types"
import Transaction from "src/libs/blockchain/transaction"
import Chain from "src/libs/blockchain/chain"
import { isWithinDeepWindow } from "src/libs/blockchain/referenceBlockWindow"

export type TxAdmissionCode =
    | "structure"
    | "signature"
    | "coherence"
    | "window"
    | "on_chain"
    | "in_mempool"

export interface TxAdmissionVerdict {
    ok: boolean
    /** Set when `ok` is false. */
    code?: TxAdmissionCode
    reason?: string
}

export interface TxAdmissionOptions {
    /** Chain head the reference-block window is measured against. */
    head: number
    /** Enforce the deep reference-block window. Off for RPC intake, which sets the reference block itself. */
    checkWindow?: boolean
    /** Reject a tx that is already pending locally. */
    checkMempool?: boolean
    /** When set, the tx signer must be this address (RPC request sender). */
    sender?: string
}

/**
 * The per-transaction admission checks shared by RPC intake and gossip
 * ingestion: well-formed, signed by its sender, hash-coherent, inside the
 * reference-block window, and not already known.
 *
 * Cheapest checks run first. Ordering is part of the contract: a caller
 * that surfaces `reason` to a client gets the same message for the same
 * defect on every node.
 *
 * The consensus mempool merge keeps its own batched versions of these
 * checks (worker-pool signature validation, set-based existence lookups)
 * because it admits thousands of txs at once; it shares the primitives,
 * not this composition.
 */
export async function checkTxAdmissible(
    tx: SdkTransaction & { reference_block?: number },
    options: TxAdmissionOptions,
): Promise<TxAdmissionVerdict> {
    // The static helpers are typed on the node's Transaction class; the
    // SDK shape is structurally identical for the fields they read.
    const txObj = tx as unknown as Transaction
    const structured = Transaction.structured(txObj)
    if (!structured.valid) {
        return { ok: false, code: "structure", reason: structured.message }
    }

    if (options.checkWindow) {
        const referenceBlock = tx.reference_block
        if (
            typeof referenceBlock !== "number" ||
            !isWithinDeepWindow(referenceBlock, options.head)
        ) {
            return {
                ok: false,
                code: "window",
                reason: `reference block ${referenceBlock} outside the allowed window at block ${options.head}`,
            }
        }
    }

    if (!Transaction.isCoherent(txObj, options.head)) {
        return {
            ok: false,
            code: "coherence",
            reason: "Transaction hash mismatch",
        }
    }

    const signature = await Transaction.validateSignature(
        txObj,
        options.sender ?? null,
    )
    if (!signature.success) {
        return { ok: false, code: "signature", reason: signature.message }
    }

    if (await Chain.checkTxExists(tx.hash)) {
        return {
            ok: false,
            code: "on_chain",
            reason: "Transaction already recorded on chain",
        }
    }

    if (options.checkMempool) {
        // Lazy import: mempool.ts imports this module's window predicate's
        // sibling helpers; a static import here would form a cycle.
        const mempoolModule = await import("src/libs/blockchain/mempool")
        if (await mempoolModule.default.checkTransactionByHash(tx.hash)) {
            return {
                ok: false,
                code: "in_mempool",
                reason: "Transaction already in mempool",
            }
        }
    }

    return { ok: true }
}
