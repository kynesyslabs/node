import { BlockContent, EncryptedTransaction } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Hashing from "src/libs/crypto/hashing"
import { RPCResponse, emptyResponse } from "../../server_rpc"
import _ from "lodash"

export default async function handleL2PS(
    content: any,
): Promise<RPCResponse> {
    // ! TODO Finalize the below TODOs
    let response = _.cloneDeep(emptyResponse)
    let data = content.data
    switch (content.extra) {
        case "retrieve":
            // TODO
            break
        case "retrieveAll":
            var block = await Chain.getBlockByNumber(data.blockNumber)
            var blockContent: BlockContent = JSON.parse(block.content)
            var encryptedTransactions = blockContent.encrypted_transactions
            response.response = encryptedTransactions
            return response
        case "registerTx":
            /* Workflow:
             * We first need to check if the payload is valid by checking the hash of the encrypted transaction.
            */
            var encryptedTxData: EncryptedTransaction = data.eTx
            // Checking if the encrypted transaction coherent
            var expectedHash = Hashing.sha256(encryptedTxData.encryptedTransaction) // Hashing the encrypted transaction
            if (expectedHash!= encryptedTxData.encryptedHash) {
                response.result = 400
                response.response = "error"
                response.require_reply = true
                response.extra = "The encrypted transaction is not coherent"
                return response
            }
            // TODO Check if the transaction is already in the L2PS
            // TODO Register the transaction in the L2PS
            response.result = 200
            response.response = "ok"
            response.require_reply = true
            response.extra = encryptedTxData.encryptedHash
            return response
        default:
            // TODO
            response.result = 400
            response.response = "error"
            response.require_reply = true
            response.extra = "Invalid extra"
            return response
    }
}