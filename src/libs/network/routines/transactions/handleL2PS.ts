import { BlockContent, EncryptedTransaction } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Hashing from "src/libs/crypto/hashing"

export default async function handleL2PS(
    content: any,
): Promise<{ response: any; require_reply: boolean; extra: any }> {
    // ! TODO Finalize the below TODOs
    let data = content.data
    switch (content.extra) {
        case "retrieve":
            // TODO
            break
        case "retrieveAll":
            var block = await Chain.getBlockByNumber(data.blockNumber)
            var blockContent: BlockContent = JSON.parse(block.content)
            var encryptedTransactions = blockContent.encrypted_transactions
            return {
                response: encryptedTransactions,
                require_reply: true,
                extra: "",
            }
        case "registerTx":
            /* Workflow:
             * We first need to check if the payload is valid by checking the hash of the encrypted transaction.
            */
            var encryptedTxData: EncryptedTransaction = data.eTx
            // Checking if the encrypted transaction coherent
            var expectedHash = Hashing.sha256(encryptedTxData.encryptedTransaction) // Hashing the encrypted transaction
            if (expectedHash!= encryptedTxData.encryptedHash) {
                return {
                    response: "error",
                    require_reply: true,
                    extra: "The encrypted transaction is not coherent",
                }
            }
            // TODO Check if the transaction is already in the L2PS
            // TODO Register the transaction in the L2PS
            return {
                response: "ok",
                require_reply: true,
                extra: encryptedTxData.encryptedHash,
            }
        default:
            // TODO
            break
    }
}