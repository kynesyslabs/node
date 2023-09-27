// INFO Entry file for handling web2 requests
import GLS from "src/libs/blockchain/gls/gls"
import { IWeb2Request } from "./types/Web2Request"
import Web2API from "./types/Web2Request"
import Transaction from "src/libs/blockchain/transaction"
import { Operation } from "src/libs/blockchain/routines/executeOperations"
import Mempool from "src/libs/blockchain/mempool"
import required from "src/utilities/required"

// INFO Upon receiving a request from a socket, we
// need to attest and handle the other attestations (if we 
// are either first or not last of the chain), and then
// send back to the client or to the origin rpc the
// transaction that will be granted as web2 result
export default async function handleWeb2(request: IWeb2Request, senderSocket: any): Promise<[boolean, any]> {
    // Creating the workable interface
    // TODO Remember that web2 could need to be signed and could need a fee
    // NOTE From now on, Web2API will reply to instanceName with the same instance
    // NOTE Also note that Web2API automatically starts the request validation
    let web2request = Web2API(senderSocket, request)
    let instanceName = web2request.name
    // And getting a response from it
    try {
        // Ensuring we reach the quorum
        required(await Web2API(instanceName).awaitQuorum(), "Not enough attestations to reach quorum")
    } catch (error) {
        return [false, error]
    }
    // At this point we have a valid, attested request: lets handle it
    let derivedTx: Transaction
    let derivedOperation: Operation
    // NOTE If all the attestations are valid we can create the transaction, insert it and gibe back the result
    // Creating a tx from the completed request if is possible
    derivedTx = await createTransactionFromCompletedRequest(Web2API(instanceName).request)
    // Deriving an operation from the tx
    derivedOperation = await createOperationFromValidTransaction(derivedTx)
    // Inserting the operation in the next mempool session with the proper data
    Mempool.addTransaction(derivedTx)
    // And we do the same for the derived operation in the GLS
    GLS.getInstance().operations.push(derivedOperation)
    // Sending back the result
    // REVIEW Maybe is more efficient somewhere else
    return [true, derivedTx]
}

// INFO A request has been validated on our side, we need to create a transaction
async function createTransactionFromCompletedRequest(request: IWeb2Request): Promise<Transaction> {
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

// INFO Given a transaction, we need to create an operation from it to insert it in the next mempool session
async function createOperationFromValidTransaction(tx: Transaction): Promise<Operation> {
    // Preparing a base Operation
    let op: Operation = {
        operator: null,
        actor: null,
        params: [],
        hash: null,
        nonce: null,
        timestamp: null,
        status: "pending",
        fees: {
            network_fee: 0,
            rpc_fee: 0,
            additional_fee: 0,
        },
    }
    // TODO Do the thing
    return op
}