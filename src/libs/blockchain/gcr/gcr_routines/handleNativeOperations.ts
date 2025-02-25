import { GCREdit } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/GCREdit"

import { Transaction } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/Transaction"
import { INativePayload } from "node_modules/@kynesyslabs/demosdk/build/types/native"

// NOTE This class is responsible for handling native operations such as sending native tokens, etc.
export class HandleNativeOperations {
    static async handle(tx: Transaction, isRollback = false): Promise<GCREdit[]> {
        // TODO Implement this
        const edits: GCREdit[] = []
        console.log("handleNativeOperations: ", tx.content.type)
        const nativePayloadData: ["native", INativePayload] = tx.content.data as ["native", INativePayload] // ? Is this typization correct and safe?
        const nativePayload: INativePayload = nativePayloadData[1]
        console.log("nativePayload: ", nativePayload)
        console.log("nativeOperation: ", nativePayload.nativeOperation)
        // Switching on the native operation type
        switch (nativePayload.nativeOperation) {
            // Balance operations for the send native method
            case "send":
                // eslint-disable-next-line no-var
                var [to, amount] = nativePayload.args
                // First, remove the amount from the sender's balance
                console.log("to: ", to)
                console.log("amount: ", amount)
                var subtractEdit: GCREdit = {
                    type: "balance",
                    operation: "remove",
                    isRollback: isRollback,
                    account: tx.content.from as string, // ? Check and enforce string type as tx.content.from
                    txhash: tx.hash,
                    amount: amount,
                }
                edits.push(subtractEdit)
                // Then, add the amount to the receiver's balance
                var addEdit: GCREdit = {
                    type: "balance",
                    operation: "add",
                    isRollback: isRollback,
                    account: to,
                    txhash: tx.hash,
                    amount: amount,
                }
                edits.push(addEdit)
                break
            default:
                console.log("Unknown native operation: ", nativePayload.nativeOperation) // TODO Better error handling
                // throw new Error("Unknown native operation: " + nativePayload.nativeOperation)
                break
        }

        return edits
    }
}

