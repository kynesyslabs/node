// INFO Entry file for handling web2 requests
import { IWeb2Request } from "./types/Web2Request"
import Web2API from "./types/Web2Request"
import Transaction from "src/libs/blockchain/transaction"
import Mempool from "src/libs/blockchain/mempool"

// INFO Upon receiving a request from a socket, we
// need to attest and handle the other attestations (if we 
// are either first or not last of the chain), and then
// send back to the client or to the origin rpc the
// transaction that will be granted as web2 result
export default async function handleWeb2(request: IWeb2Request, senderSocket: any): Promise<[boolean, any]> {
    // Creating the workable interface
    let web2request = new Web2API(senderSocket, request)
    // And getting a response from it
    let response: IWeb2Request
    try {
        response = await web2request.attest()
    } catch (error) {
        return [false, error]
    }
    // TODO and REVIEW Should we understand here or there if to verify etc etc?
    let derivedTx: Transaction
    // If all the attestations are valid we can create the transaction, insert it and gibe back the result
    if(request.attestations.size >= response.content.minAttestations) {
        // Creating a tx from the completed request if is possible
        derivedTx = await createTransactionFromCompletedRequest(request)
        // Inserting the operation in the next mempool session with the proper data
        Mempool.addTransaction(derivedTx)
        // Sending back the result
        // REVIEW Maybe is more efficient somewhere else
        return [true, derivedTx]
    }
}

async function createTransactionFromCompletedRequest(request: IWeb2Request) {
    let tx: Transaction = {
        content: null,
        signature: null,
        hash: null,
        confirmations: null,
        state_changes: null,
    }
    // TODO Do it
    return tx
}