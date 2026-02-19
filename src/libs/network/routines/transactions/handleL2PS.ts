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
    l2psTx: L2PSTransaction,
): Promise<{ decryptedTx: Transaction | null; error: string | null }> {
    let decryptedTx
    try {
        decryptedTx = await l2psInstance.decryptTx(l2psTx)
    } catch (error) {
        return {
            decryptedTx: null,
            error: `Decryption failed: ${error instanceof Error ? error.message : "Unknown error"}`,
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
 * Check sender balance before mempool insertion.
 * Returns an error message if balance is insufficient, null if OK.
 */
async function checkSenderBalance(decryptedTx: Transaction): Promise<string | null> {
    const sender = decryptedTx.content.from as string
    if (!sender) return "Missing sender address in decrypted transaction"

    // Extract amount from native payload
    let amount = 0
    if (decryptedTx.content.type === "native" && Array.isArray(decryptedTx.content.data)) {
        const nativePayload = decryptedTx.content.data[1] as INativePayload
        if (nativePayload?.nativeOperation === "send") {
            const [, sendAmount] = nativePayload.args as [string, number]
            amount = sendAmount || 0
        }
    }

    const totalRequired = amount + L2PS_TX_FEE
    try {
        const balance = await L2PSTransactionExecutor.getBalance(sender)
        if (balance < BigInt(totalRequired)) {
            return `Insufficient balance: need ${totalRequired} (${amount} + ${L2PS_TX_FEE} fee) but have ${balance}`
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

    // Pre-check sender balance BEFORE mempool insertion
    const balanceError = await checkSenderBalance(decryptedTx)
    if (balanceError) {
        log.error(`[handleL2PS] Balance pre-check failed: ${balanceError}`)
        return createErrorResponse(response, 400, balanceError)
    }

    // Process Valid Transaction
    return await processValidL2PSTransaction(response, l2psUid, l2psTx, decryptedTx, originalHash)
}

/**
 * Process a validated L2PS transaction (check mempool, store, execute)
 */
async function processValidL2PSTransaction(
    response: RPCResponse,
    l2psUid: string,
    l2psTx: L2PSTransaction,
    decryptedTx: Transaction,
    originalHash: string,
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
    originalHash: string,
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
            executionResult.affected_accounts_count || 0,
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
            "pending", // Initial status - executed locally, waiting for aggregation
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
            gcr_edits_count: executionResult.gcr_edits?.length || 0,
        },
    }
    return response
}
