/* eslint-disable no-unused-vars */
import Transaction from "../blockchain/transaction"
import { Operation } from "../blockchain/routines/executeOperations"
import Mempool from "../blockchain/mempool"
import GLS from "../blockchain/gls/gls"

export async function deriveMempoolOperation(
    data: any,
    insert: boolean = true,
): Promise<any> {
    // Sanity check
    if (typeof(data) !== "string") {
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
    derivedTx = await createTransaction(data)
    // Deriving an operation from the tx
    derivedOperation = await createOperation(derivedTx)
    if (insert) {
        // Inserting the operation in the next mempool session with the proper data
        Mempool.addTransaction(derivedTx)
        // And we do the same for the derived operation in the GLS
        GLS.getInstance().operations.push(derivedOperation)
    }
    return derivedOperation
}

export async function createOperation(transaction: Transaction): Promise<Operation> {
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
    // TODO
    return operation
}

export async function createTransaction(
    data: any,
): Promise<Transaction> {
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
        state_changes: [],
    }
    transaction.content.data["content"] = data
    // TODO
    return transaction
}