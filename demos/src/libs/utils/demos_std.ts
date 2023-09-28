import Transaction from "../blockchain/transaction"
import { Operation } from "../blockchain/routines/executeOperations"
import { TxFee } from "../blockchain/types/transactions"
import { TransactionContent } from "../blockchain/types/transactions"
import * as forge from "node-forge"


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