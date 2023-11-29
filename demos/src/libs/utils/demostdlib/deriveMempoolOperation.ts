/* eslint-disable no-unused-vars */
import Transaction from "../../blockchain/transaction"
import { Operation } from "../../blockchain/routines/executeOperations"
import Mempool from "../../blockchain/mempool"
import GLS from "../../blockchain/gls/gls"
import sharedState from "src/utilities/sharedState"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"

// REVIEW See if is fixed (should return something)
// INFO Deriving a mempool operation from a given data by deriving a tx and the corresponding mempool operation
export async function deriveMempoolOperation(
    data: any,
    insert: boolean = true,
): Promise<any> {
    // Sanity check
    if (typeof data !== "string") {
        try {
            data = JSON.stringify(data)
        } catch (e) {
            console.log(e)
            return false
        }
    }
    // We should have a valid, attested request: lets handle it
    let derivedTx: Transaction
    let derivedOperation: Operation
    // Deriving a transaction
    derivedTx = await createTransaction(data) // A simple tx with web2 data inside
    console.log("Derived tx:")
    console.log(derivedTx)
    // Deriving an operation from the tx
    derivedOperation = await createOperation(derivedTx) // An operation witnessing the validity of the web2 request
    console.log("Derived operation:")
    console.log(derivedOperation)
    if (insert) {
        // Inserting the operation in the next mempool session with the proper data
        Mempool.addTransaction(derivedTx)
        // And we do the same for the derived operation in the GLS
        GLS.getInstance().operations.push(derivedOperation)
    }
    return derivedOperation
}

export async function createOperation(
    transaction: Transaction,
): Promise<Operation> {
    let operation: Operation = {
        operator: null,
        actor: null,
        params: null,
        hash: null,
        nonce: null,
        timestamp: null,
        status: "pending",
        fees: {
            network_fee: null,
            rpc_fee: null,
            additional_fee: null,
        },
    }
    operation.operator = "Web2Certification"
    operation.nonce = 0 // TODO Get it from chain or gls or whatever it is
    operation.timestamp = transaction.content.timestamp
    operation.params = transaction.content.data
    operation.status = true // TODO Get it from the content itself somehow

    // TODO Fee calculation logic here
    operation.fees.network_fee = 0
    operation.fees.rpc_fee = 0
    operation.fees.additional_fee = 0

    return operation
}

export async function createTransaction(data: any): Promise<Transaction> {
    let transaction: Transaction = {
        content: {
            type: null,
            from: null,
            to: null,
            amount: null,
            data: ["content", null], // type as string and content in hex string
            nonce: null, // Increments every time a transaction is sent from the same account
            timestamp: null, // Is the registered unix timestamp when the transaction was sent the first time
            transaction_fee: {
                network_fee: null,
                rpc_fee: null,
                additional_fee: null,
            },
        },
        signature: null,
        hash: null,
        confirmations: [],
        status: null,
    }
    transaction.content.data = data
    transaction.content.timestamp = Date.now()
    // Hashing the content and signing the transaction
    transaction.hash = Hashing.sha256(JSON.stringify(transaction.content))
    transaction.signature = Cryptography.sign(
        transaction.hash,
        sharedState.getInstance().identity.ed25519.privateKey,
    )
    // TODO See how to be general purpose but specific (a shared format?)
    return transaction
}
