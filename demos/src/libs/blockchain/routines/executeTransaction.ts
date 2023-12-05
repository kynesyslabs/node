/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/* NOTE
    executeTransaction is called BEFORE the transaction is reflected in the GLS, which happens AFTER the
    consensus has confirmed the transaction in the block.
*/


import Transaction from "../transaction"
import GLS from "../gls/gls"
import { Operation } from "../gls/gls"

/* NOTE 

Rationale: transactions arrives with a nonce and a timestamp.

The operations contained in a transaction are calculated by executeTransaction, the output is stored
as Operation objects in the GLS.

Each block, the nodes execute the Operation objects ordering them by their timestamp and nonce (see GLS).

*/

// INFO Given a transaction, use GLS to see if it is executable and return a result
export default async function executeTransaction(transaction: Transaction): Promise<[boolean, string, Operation[]]> {

    let success: boolean = true
    let message: string = ""
    let operations: Operation[] = []

 
    // ANCHOR Managing simple value transfer
    if (transaction.content.amount > 0) {
        let operation: Operation
        let sender = transaction.content.from.toString("hex")
        let sender_balance = await GLS.getGLSNativeBalance(sender)
        let receiver = transaction.content.to.toString("hex")
        let receiver_balance = await GLS.getGLSNativeBalance(receiver)
        // Refuse transaction if GLS is not in shape
        if (sender_balance < transaction.content.amount) {
            success = false
            message = "Insufficient funds"
            return [success, message]
        }
        // Add value to receiver's balance
        operation = {
            operator: "add_native",
            actor: receiver,
            params: {amount: transaction.content.amount},
            hash: transaction.hash,
            nonce: transaction.content.nonce,
            timestamp: transaction.content.timestamp,
            status: "pending",
            fees: transaction.content.transaction_fee,
        }
        // Adding the operation to the list of operations
        operations.push(operation)
        // Subtract value from sender's balance
        operation = {
            operator: "remove_native",
            actor: sender,
            params: {amount: transaction.content.amount},
            hash: transaction.hash,
            nonce: transaction.content.nonce,
            timestamp: transaction.content.timestamp,
            status: "pending",
            fees: transaction.content.transaction_fee,
        }
        // Adding the operation to the list of operations
        operations.push(operation)
        success = true
        message = "Transaction successful"
        return [success, message, operations]
    }

    // ANCHOR Managing complex operations
    if (transaction.content.data[0] === "execute") {
        // TODO Execute the code based on a currently not defined schema
    }

    return [success, message, operations]
}