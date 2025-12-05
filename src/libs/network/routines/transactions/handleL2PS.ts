import type { BlockContent } from "@kynesyslabs/demosdk/types"
import type { L2PSTransaction } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Transaction from "src/libs/blockchain/transaction"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "../../server_rpc"
import _ from "lodash"
import { L2PS, L2PSEncryptedPayload } from "@kynesyslabs/demosdk/l2ps"
import ParallelNetworks from "@/libs/l2ps/parallelNetworks"
import L2PSMempool from "@/libs/blockchain/l2ps_mempool"
import L2PSTransactionExecutor from "@/libs/l2ps/L2PSTransactionExecutor"
import log from "@/utilities/logger"
/* NOTE
- Each l2ps is a list of nodes that are part of the l2ps
- Each l2ps partecipant has the private key of the l2ps (or equivalent)
- Each l2ps partecipant can register a transaction in the l2ps
- Each l2ps partecipant can retrieve a transaction from the l2ps
- // ! TODO For each l2ps message, it can be specified another key shared between the session partecipants only
- // ! TODO Only nodes that partecipate to the l2ps will maintain a copy of the l2ps transactions
- // ! TODO The non partecipating nodes will have a encrypted transactions hash property

*/


export default async function handleL2PS(
    l2psTx: L2PSTransaction,
): Promise<RPCResponse> {
    // ! TODO Finalize the below TODOs
    const response = _.cloneDeep(emptyResponse)

    // REVIEW: PR Fix #10 - Validate nested data access before use
    if (!l2psTx.content || !l2psTx.content.data || !l2psTx.content.data[1] || !l2psTx.content.data[1].l2ps_uid) {
        response.result = 400
        response.response = false
        response.extra = "Invalid L2PS transaction structure: missing l2ps_uid in data payload"
        return response
    }

    // REVIEW: PR Fix #Medium4 - Extract payload data once after validation
    // L2PS transaction data structure: data[0] = metadata, data[1] = L2PS payload
    const payloadData = l2psTx.content.data[1]

    // Defining a subnet from the uid: checking if we have the config or if its loaded already
    const parallelNetworks = ParallelNetworks.getInstance()
    const l2psUid = payloadData.l2ps_uid
    // REVIEW: PR Fix #Low1 - Use let instead of var for better scoping
    let l2psInstance = await parallelNetworks.getL2PS(l2psUid)
    if (!l2psInstance) {
        // Try to load the l2ps from the local storage (if the node is part of the l2ps)
        l2psInstance = await parallelNetworks.loadL2PS(l2psUid)
        if (!l2psInstance) {
            response.result = 400
            response.response = false
            response.extra = "L2PS network not found and not joined (missing config)"
            return response
        }
    }
    // Now we should have the l2ps instance, we can decrypt the transaction
    // REVIEW: PR Fix #6 - Add error handling for decryption and null safety checks
    let decryptedTx
    try {
        decryptedTx = await l2psInstance.decryptTx(l2psTx)
    } catch (error) {
        response.result = 400
        response.response = false
        response.extra = `Decryption failed: ${error instanceof Error ? error.message : "Unknown error"}`
        return response
    }

    if (!decryptedTx || !decryptedTx.content || !decryptedTx.content.from) {
        response.result = 400
        response.response = false
        response.extra = "Invalid decrypted transaction structure"
        return response
    }

    // NOTE Hash is already verified in the decryptTx function (sdk)

    // NOTE Re-verify the decrypted transaction signature using the same method as other transactions
    // This is necessary because the L2PS transaction was encrypted and bypassed initial verification.
    // The encrypted L2PSTransaction was verified, but we need to verify the underlying Transaction
    // after decryption to ensure integrity of the actual transaction content.
    const verificationResult = await Transaction.confirmTx(decryptedTx, decryptedTx.content.from)
    if (!verificationResult) {
        response.result = 400
        response.response = false
        response.extra = "Transaction signature verification failed"
        return response
    }

    // REVIEW: PR Fix #11 - Validate encrypted payload structure before type assertion
    // Reuse payloadData extracted earlier (line 38)
    if (!payloadData || typeof payloadData !== "object" || !("original_hash" in payloadData)) {
        response.result = 400
        response.response = false
        response.extra = "Invalid L2PS payload: missing original_hash field"
        return response
    }

    // Extract original hash from encrypted payload for duplicate detection
    const encryptedPayload = payloadData as L2PSEncryptedPayload
    const originalHash = encryptedPayload.original_hash

    // Check for duplicates (prevent reprocessing)
    // REVIEW: PR Fix #7 - Add error handling for mempool operations
    let alreadyProcessed
    try {
        alreadyProcessed = await L2PSMempool.existsByOriginalHash(originalHash)
    } catch (error) {
        response.result = 500
        response.response = false
        response.extra = `Mempool check failed: ${error instanceof Error ? error.message : "Unknown error"}`
        return response
    }

    if (alreadyProcessed) {
        response.result = 409
        response.response = "Transaction already processed"
        response.extra = "Duplicate L2PS transaction detected"
        return response
    }
    
    // Store encrypted transaction (NOT decrypted) in L2PS-specific mempool
    // This preserves privacy while enabling DTR hash generation
    const mempoolResult = await L2PSMempool.addTransaction(
        l2psUid, 
        l2psTx, 
        originalHash, 
        "processed",
    )
    
    if (!mempoolResult.success) {
        response.result = 500
        response.response = false
        response.extra = `Failed to store in L2PS mempool: ${mempoolResult.error}`
        return response
    }
    
    // Execute the decrypted transaction within the L2PS network (unified state)
    // This validates against L1 state and generates proofs (GCR edits applied at consensus)
    let executionResult
    try {
        // Use the encrypted transaction hash as the L1 batch hash reference
        // The actual L1 batch hash will be set when the batch is submitted
        const l1BatchHash = l2psTx.hash // Temporary - will be updated when batched
        executionResult = await L2PSTransactionExecutor.execute(
            l2psUid,
            decryptedTx,
            l1BatchHash,
            false // not a simulation - create proof
        )
    } catch (error) {
        log.error(`[handleL2PS] Execution error: ${error instanceof Error ? error.message : "Unknown error"}`)
        // Update mempool status to failed (use encrypted tx hash, not originalHash)
        await L2PSMempool.updateStatus(l2psTx.hash, "failed")
        response.result = 500
        response.response = false
        response.extra = `L2PS transaction execution failed: ${error instanceof Error ? error.message : "Unknown error"}`
        return response
    }

    if (!executionResult.success) {
        // Update mempool status to failed (use encrypted tx hash, not originalHash)
        await L2PSMempool.updateStatus(l2psTx.hash, "failed")
        response.result = 400
        response.response = false
        response.extra = `L2PS transaction execution failed: ${executionResult.message}`
        return response
    }

    // Update mempool status to executed (use encrypted tx hash)
    await L2PSMempool.updateStatus(l2psTx.hash, "executed")

    response.result = 200
    response.response = {
        message: "L2PS transaction validated - proof created for consensus",
        encrypted_hash: l2psTx.hash,
        original_hash: originalHash,
        l2ps_uid: l2psUid,
        // REVIEW: PR Fix #4 - Return only hash for verification, not full plaintext (preserves L2PS privacy)
        decrypted_tx_hash: decryptedTx.hash,
        execution: {
            success: executionResult.success,
            message: executionResult.message,
            affected_accounts: executionResult.affected_accounts,
            proof_id: executionResult.proof_id // ID of proof to be applied at consensus
        }
    }
    return response
}
