import type { BlockContent, L2PSTransaction } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Transaction from "src/libs/blockchain/transaction"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "../../server_rpc"
import _ from "lodash"
import { L2PS, L2PSEncryptedPayload } from "@kynesyslabs/demosdk/l2ps"
import ParallelNetworks from "@/libs/l2ps/parallelNetworks"
import L2PSMempool from "@/libs/blockchain/l2ps_mempool"
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
    const decryptedTx = await l2psInstance.decryptTx(l2psTx)
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
    const alreadyProcessed = await L2PSMempool.existsByOriginalHash(originalHash)
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
    
    // TODO Is the execution to be delegated to the l2ps nodes? As it cannot be done by the consensus as it will be in the future for the other txs
    response.result = 200
    response.response = {
        message: "L2PS transaction processed and stored",
        encrypted_hash: l2psTx.hash,
        original_hash: originalHash,
        l2ps_uid: l2psUid,
        // REVIEW: PR Fix #4 - Return only hash for verification, not full plaintext (preserves L2PS privacy)
        decrypted_tx_hash: decryptedTx.hash, // Hash only for verification, not full plaintext
    }
    return response
}
