import { BlockContent, EncryptedTransaction } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Hashing from "src/libs/crypto/hashing"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "../../server_rpc"
import _ from "lodash"

/* NOTE
- Each l2ps is a list of nodes that are part of the l2ps
- Each l2ps partecipant has the private key of the l2ps (or equivalent)
- Each l2ps partecipant can register a transaction in the l2ps
- Each l2ps partecipant can retrieve a transaction from the l2ps
- // ! TODO For each l2ps message, it can be specified another key shared between the session partecipants only
- // ! TODO Only nodes that partecipate to the l2ps will maintain a copy of the l2ps transactions
- // ! TODO The non partecipating nodes will have a encrypted transactions hash property

*/

// SECTION L2PS Message types and interfaces

export interface L2PSMessage {
    type: "retrieve" | "retrieveAll" | "registerTx" | "registerAsPartecipant"
    data: any
    extra: string
}

export interface L2PSRetrieveAllTxMessage extends L2PSMessage {
    type: "retrieveAll"
    data: {
        blockNumber: number
    }
}

export interface L2PSRegisterTxMessage extends L2PSMessage {
    type: "registerTx"
    data: {
        encryptedTransaction: EncryptedTransaction
    }
}

export default async function handleL2PS(
    content: L2PSMessage,
): Promise<RPCResponse> {
    // ! TODO Finalize the below TODOs
    let response = _.cloneDeep(emptyResponse)
    let data = content.data
    // REVIEW Experimental type tightening
    let payloadContent: L2PSRetrieveAllTxMessage | L2PSRegisterTxMessage
    switch (content.extra) {
        case "retrieve":
            // TODO
            break
        // This will retrieve all the transactions from the L2PS on a given block
        case "retrieveAll":
            payloadContent = content as L2PSRetrieveAllTxMessage
            var block = await Chain.getBlockByNumber(
                payloadContent.data.blockNumber,
            )
            var blockContent: BlockContent = JSON.parse(block.content)
            var encryptedTransactions = blockContent.encrypted_transactions
            response.response = encryptedTransactions
            return response
        // This will register a transaction in the L2PS
        case "registerTx":
            /* Workflow:
             * We first need to check if the payload is valid by checking the hash of the encrypted transaction.
             */
            payloadContent = content as L2PSRegisterTxMessage
            var encryptedTxData: EncryptedTransaction =
                payloadContent.data.encryptedTransaction
            // Checking if the encrypted transaction coherent
            var expectedHash = Hashing.sha256(
                encryptedTxData.encryptedTransaction,
            ) // Hashing the encrypted transaction
            if (expectedHash != encryptedTxData.encryptedHash) {
                response.result = 422
                response.response = "Unprocessable Entity"
                response.require_reply = true
                response.extra = "The encrypted transaction is not coherent"
                return response
            }
            // TODO Check if the transaction is already in the L2PS
            // TODO Register the transaction in the L2PS if this node is inside the L2PS (See block.content.l2ps_partecipating_nodes)
            response.result = 200
            response.response = "ok"
            response.require_reply = true
            response.extra = encryptedTxData.encryptedHash
            return response
        // SECTION Management methods
        case "registerAsPartecipant":
            // TODO
            break
        default:
            // TODO
            response.result = 400
            response.response = "error"
            response.require_reply = true
            response.extra = "Invalid extra"
            return response
    }
}
