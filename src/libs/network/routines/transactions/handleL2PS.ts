import type { BlockContent, L2PSTransaction, RPCResponse, INativePayload } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Transaction from "src/libs/blockchain/transaction"
import { emptyResponse } from "../../server_rpc"

import { L2PS, L2PSEncryptedPayload } from "@kynesyslabs/demosdk/l2ps"
import ParallelNetworks from "@/libs/l2ps/parallelNetworks"
import L2PSMempool from "@/libs/blockchain/l2ps_mempool"
import L2PSTransactionExecutor, { L2PS_TX_FEE } from "@/libs/l2ps/L2PSTransactionExecutor"
import log from "@/utilities/logger"

/**
 * Create an error response with the given status code and message
 */
function createErrorResponse(response: RPCResponse, code: number, message: string): RPCResponse {
    response.result = code
    response.response = false
    response.extra = message
    return response
}

/**
 * Validate L2PS transaction structure
 */
function validateL2PSStructure(l2psTx: L2PSTransaction): string | null {
    if (!l2psTx.content?.data?.[1]?.l2ps_uid) {
        return "Invalid L2PS transaction structure: missing l2ps_uid in data payload"
    }
    return null
}

/**
 * Get or load L2PS instance
 */
async function getL2PSInstance(l2psUid: string): Promise<L2PS | null> {
    const parallelNetworks = ParallelNetworks.getInstance()
    let l2psInstance = await parallelNetworks.getL2PS(l2psUid)
    if (!l2psInstance) {
        l2psInstance = await parallelNetworks.loadL2PS(l2psUid)
    }
    return l2psInstance
}

/**
 * Decrypt and validate L2PS transaction
 */
async function decryptAndValidate(
    l2psInstance: L2PS,
    l2psTx: L2PSTransaction
): Promise<{ decryptedTx: Transaction | null; error: string | null }> {
    let decryptedTx
    try {
        decryptedTx = await l2psInstance.decryptTx(l2psTx)
    } catch (error) {
        return {
            decryptedTx: null,
            error: `Decryption failed: ${error instanceof Error ? error.message : "Unknown error"}`
        }
    }

    if (!decryptedTx?.content?.from) {
        return { decryptedTx: null, error: "Invalid decrypted transaction structure" }
    }

    const verificationResult = await Transaction.confirmTx(decryptedTx, decryptedTx.content.from)
    if (!verificationResult || !verificationResult.success) {
        const errorMsg = verificationResult?.message || "Transaction signature verification failed"
        return { decryptedTx: null, error: errorMsg }
    }

    return { decryptedTx: decryptedTx as unknown as Transaction, error: null }
}



/**
 * Per-sender in-process serialisation gate for the balance pre-check.
 *
 * Without this, two concurrent broadcasts from the same sender both
 * race past `checkSenderBalance` while the on-chain state still shows
 * the pre-debit balance — the executor then debits twice from a wallet
 * that only had funds for one. The serial-by-sender lock funnels every
 * (check + insert + execute) sequence for a single sender so the second
 * tx sees the balance the first one will land on. In-process is
 * sufficient because every L2PS tx for a given sender arrives through
 * one node entry point; cross-node ordering is already handled
 * downstream by the mempool + consensus pipeline.
 */
const senderLocks = new Map<string, Promise<void>>()
async function withSenderLock<T>(
    sender: string,
    fn: () => Promise<T>,
): Promise<T> {
    const previous = senderLocks.get(sender) ?? Promise.resolve()
    let release: () => void = () => undefined
    const next = new Promise<void>(res => {
        release = res
    })
    senderLocks.set(sender, previous.then(() => next))
    try {
        await previous
        return await fn()
    } finally {
        release()
        // Drop the map entry once the queue has drained so long-lived
        // senders don't leak entries here.
        if (senderLocks.get(sender) === previous.then(() => next)) {
            senderLocks.delete(sender)
        }
    }
}

/**
 * Whether the decrypted tx is an L2PS-fee-bearing operation. Mirrors
 * `L2PSTransactionExecutor.handleNativeTransaction()`, which only burns
 * `L2PS_TX_FEE` on `native` / `send`. Charging the fee on any other tx
 * type would incorrectly reject valid L2PS payloads at this gate.
 */
function isL2PSFeeBearing(decryptedTx: Transaction): boolean {
    if (decryptedTx.content.type !== "native") return false
    const data = decryptedTx.content.data
    if (!Array.isArray(data)) return false
    const payload = data[1] as INativePayload | undefined
    return payload?.nativeOperation === "send"
}

/**
 * Check sender balance before mempool insertion.
 * Returns an error message if balance is insufficient, null if OK.
 *
 * `L2PS_TX_FEE` is only added when the inner tx actually burns it — the
 * executor charges it solely on `native` / `send`, so charging it here
 * for other tx types incorrectly rejected valid payloads.
 */
async function checkSenderBalance(decryptedTx: Transaction): Promise<string | null> {
    const sender = decryptedTx.content.from as string
    if (!sender) return "Missing sender address in decrypted transaction"

    const feeBearing = isL2PSFeeBearing(decryptedTx)

    // `amount` is only meaningful when the inner tx is a native send.
    let amount = 0
    if (feeBearing) {
        const [, sendAmount] = (decryptedTx.content.data as any[])[1]
            .args as [string, number]
        if (typeof sendAmount !== "number" || !Number.isFinite(sendAmount) || sendAmount < 0) {
            return `Invalid native send amount: ${String(sendAmount)}`
        }
        amount = sendAmount
    }

    const fee = feeBearing ? L2PS_TX_FEE : 0
    const totalRequired = amount + fee
    if (totalRequired === 0) return null

    try {
        const balance = await L2PSTransactionExecutor.getBalance(sender)
        if (balance < BigInt(totalRequired)) {
            return `Insufficient balance: need ${totalRequired} (${amount} + ${fee} fee) but have ${balance}`
        }
    } catch (error) {
        return `Balance check failed: ${error instanceof Error ? error.message : "Unknown error"}`
    }

    return null
}

export default async function handleL2PS(
    l2psTx: L2PSTransaction,
): Promise<RPCResponse> {
    const response = structuredClone(emptyResponse)

    // Validate transaction structure
    const structureError = validateL2PSStructure(l2psTx)
    if (structureError) {
        return createErrorResponse(response, 400, structureError)
    }

    const payloadData = l2psTx.content.data[1]
    const l2psUid = payloadData.l2ps_uid

    // Get L2PS instance
    const l2psInstance = await getL2PSInstance(l2psUid)
    if (!l2psInstance) {
        return createErrorResponse(response, 400, "L2PS network not found and not joined (missing config)")
    }

    // Decrypt and validate transaction
    const { decryptedTx, error: decryptError } = await decryptAndValidate(l2psInstance, l2psTx)
    if (decryptError || !decryptedTx) {
        return createErrorResponse(response, 400, decryptError || "Decryption failed")
    }

    // Validate payload structure
    if (!payloadData || typeof payloadData !== "object" || !("original_hash" in payloadData)) {
        return createErrorResponse(response, 400, "Invalid L2PS payload: missing original_hash field")
    }

    const encryptedPayload = payloadData as L2PSEncryptedPayload
    const originalHash = encryptedPayload.original_hash

    // Verify decrypted hash matches original hash declared in payload
    if (decryptedTx.hash !== originalHash) {
        return createErrorResponse(response, 400, `Decrypted transaction hash mismatch: expected ${originalHash}, got ${decryptedTx.hash}`)
    }

    const sender = decryptedTx.content.from as string
    if (!sender) {
        return createErrorResponse(
            response,
            400,
            "Missing sender address in decrypted transaction",
        )
    }

    // Serialise (check + insert + execute) per sender — see
    // `withSenderLock` for why this closes the TOCTOU window between
    // the balance read and the executor debit. Two concurrent
    // broadcasts from the same wallet without this gate would both
    // see the pre-debit balance and both pass.
    return await withSenderLock(sender, async () => {
        const balanceError = await checkSenderBalance(decryptedTx)
        if (balanceError) {
            log.error(`[handleL2PS] Balance pre-check failed: ${balanceError}`)
            return createErrorResponse(response, 400, balanceError)
        }
        return await processValidL2PSTransaction(
            response,
            l2psUid,
            l2psTx,
            decryptedTx,
            originalHash,
        )
    })
}

/**
 * Process a validated L2PS transaction (check mempool, store, execute)
 */
async function processValidL2PSTransaction(
    response: RPCResponse,
    l2psUid: string,
    l2psTx: L2PSTransaction,
    decryptedTx: Transaction,
    originalHash: string
): Promise<RPCResponse> {
    // Check for duplicates
    let alreadyProcessed
    try {
        alreadyProcessed = await L2PSMempool.existsByOriginalHash(originalHash)
    } catch (error) {
        return createErrorResponse(response, 500, `Mempool check failed: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    if (alreadyProcessed) {
        response.result = 409
        response.response = "Transaction already processed"
        response.extra = "Duplicate L2PS transaction detected"
        return response
    }

    // Store in mempool
    const mempoolResult = await L2PSMempool.addTransaction(l2psUid, l2psTx, originalHash, "processed")
    if (!mempoolResult.success) {
        return createErrorResponse(response, 500, `Failed to store in L2PS mempool: ${mempoolResult.error}`)
    }

    // Execute transaction
    return await executeAndRecordL2PSTransaction(response, l2psUid, l2psTx, decryptedTx, originalHash)
}

/**
 * Execute L2PS transaction and record history
 */
async function executeAndRecordL2PSTransaction(
    response: RPCResponse,
    l2psUid: string,
    l2psTx: L2PSTransaction,
    decryptedTx: Transaction,
    originalHash: string
): Promise<RPCResponse> {
    let executionResult
    try {
        executionResult = await L2PSTransactionExecutor.execute(l2psUid, decryptedTx, l2psTx.hash, false)
    } catch (error) {
        log.error(`[handleL2PS] Execution error: ${error instanceof Error ? error.message : "Unknown error"}`)
        await L2PSMempool.updateStatus(l2psTx.hash, "failed")
        return createErrorResponse(response, 500, `L2PS transaction execution failed: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    if (!executionResult.success) {
        await L2PSMempool.updateStatus(l2psTx.hash, "failed")
        return createErrorResponse(response, 400, `L2PS transaction execution failed: ${executionResult.message}`)
    }

    // Store GCR edits in mempool for batch aggregation
    if (executionResult.gcr_edits && executionResult.gcr_edits.length > 0) {
        await L2PSMempool.updateGCREdits(
            l2psTx.hash,
            executionResult.gcr_edits,
            executionResult.affected_accounts_count || 0
        )
    }

    // Update status and return success
    await L2PSMempool.updateStatus(l2psTx.hash, "executed")

    // Record transaction in l2ps_transactions table for persistent history
    try {
        await L2PSTransactionExecutor.recordTransaction(
            l2psUid,
            decryptedTx,
            "", // l1BatchHash - empty initially, will be updated during consensus
            l2psTx.hash, // encrypted_hash
            0, // batch_index
            "pending" // Initial status - executed locally, waiting for aggregation
        )
        log.info(`[handleL2PS] Recorded transaction ${decryptedTx.hash.slice(0, 16)}... to history as 'pending'`)
    } catch (recordError) {
        log.error(`[handleL2PS] Failed to record transaction history: ${recordError instanceof Error ? recordError.message : "Unknown error"}`)
        // Don't fail the transaction, just log the error
    }

    response.result = 200
    response.response = {
        message: "L2PS transaction executed - awaiting batch aggregation",
        encrypted_hash: l2psTx.hash,
        original_hash: originalHash,
        l2ps_uid: l2psUid,
        decrypted_tx_hash: decryptedTx.hash,
        execution: {
            success: executionResult.success,
            message: executionResult.message,
            affected_accounts_count: executionResult.affected_accounts_count,
            gcr_edits_count: executionResult.gcr_edits?.length || 0
        }
    }
    return response
}
