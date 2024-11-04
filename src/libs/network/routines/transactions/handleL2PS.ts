import { BlockContent, EncryptedTransaction } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import Hashing from "src/libs/crypto/hashing"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "../../server_rpc"
import _ from "lodash"
import { L2PSMessage, L2PSRetrieveAllTxMessage, L2PSRegisterTxMessage } from "src/libs/l2ps/parallelNetworks"
import { Subnet } from "src/libs/l2ps/parallelNetworks"
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
    content: L2PSMessage,
): Promise<RPCResponse> {
    // ! TODO Finalize the below TODOs
    let response = _.cloneDeep(emptyResponse)
    let data = content.data
    // REVIEW Defining a subnet from the uid
    let subnet: Subnet = new Subnet(content.data.uid)
    // REVIEW Experimental type tightening
    let payloadContent: L2PSRetrieveAllTxMessage | L2PSRegisterTxMessage
    switch (content.extra) {
        case "retrieve":
            // TODO
            break
        // This will retrieve all the transactions from the L2PS on a given block
        case "retrieveAll":
            payloadContent = content as L2PSRetrieveAllTxMessage
            response = await subnet.getTransactions(payloadContent.data.blockNumber)
            return response
        // This will register a transaction in the L2PS
        case "registerTx":
            payloadContent = content as L2PSRegisterTxMessage
            var encryptedTxData: EncryptedTransaction =
                payloadContent.data.encryptedTransaction
            // REVIEW Using the subnet to register the transaction
            response = await subnet.registerTx(encryptedTxData)
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
