/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/* NOTE
    executeTransaction is called BEFORE the transaction is reflected in the GCR, which happens AFTER the
    consensus has confirmed the transaction in the block.
*/

import GCR from "../gcr/gcr"
import Transaction from "../transaction"
import { Operation } from "@kynesyslabs/demosdk/types"
import { forgeToHex } from "@/libs/crypto/forgeUtils"

/* NOTE 

Rationale: transactions arrives with a nonce and a timestamp.

The operations contained in a transaction are calculated by executeTransaction, the output is stored
as Operation objects in the GCR.

Each block, the nodes execute the Operation objects ordering them by their timestamp and nonce (see GCR).

*/

// INFO Given a transaction, use GCR to see if it is executable and return a result
export default async function executeNativeTransaction(
    transaction: Transaction,
): Promise<[boolean, string, Operation[]?]> {
    let success = true
    let message = ""
    const operations: Operation[] = []

    // ANCHOR Managing simple value transfer
    // REVIEW P5a: SDK 3.1.0 widened `amount` to `string | number` for the
    // dual-format wire shape. Coerce to bigint for the comparison so
    // pre-fork DEM-number and post-fork OS-string inputs both work.
    if (BigInt(transaction.content.amount ?? 0) > 0n) {
        let operation: Operation
        // Handle both string and Buffer types for from/to fields
        const sender =
            typeof transaction.content.from === "string"
                ? transaction.content.from
                : forgeToHex(transaction.content.from)
        const senderBalance = await GCR.getGCRNativeBalance(sender)
        const receiver =
            typeof transaction.content.to === "string"
                ? transaction.content.to
                : forgeToHex(transaction.content.to)
        const receiverBalance = await GCR.getGCRNativeBalance(receiver)
        // Refuse transaction if GCR is not in shape
        // REVIEW senderBalance is bigint; coerce content.amount (currently
        // number on the wire) to bigint for a type-safe comparison.
        if (senderBalance < BigInt(transaction.content.amount)) {
            success = false
            message = "Insufficient funds"
            return [success, message]
        }
        // Add value to receiver's balance
        operation = {
            operator: "add_native",
            actor: receiver,
            params: { amount: transaction.content.amount },
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
            params: { amount: transaction.content.amount },
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
    if (transaction.content.data[0] === "demoswork") {
        // TODO Execute the code based on a currently not defined schema
    }

    return [success, message, operations]
}
