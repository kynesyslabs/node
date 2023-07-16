import Transaction from '../transaction';
import GLS from '../gls/gls';
import { Operation } from "../gls/gls"

/* NOTE 

Rationale: transactions arrives with a nonce and a timestamp.

The operations contained in a transaction are calculated by executeTransaction, the output is stored
as Operation objects in the GLS.

Each block, the nodes execute the Operation objects ordering them by their timestamp and nonce (see GLS).

*/

// INFO Given a transaction, use GLS to see if it is executable and return a result
export default async function executeTransaction(transaction: Transaction): Promise<[boolean, string]> {
	let gls: GLS
	let success: boolean
	let message: string

	// Getting the GLS instance
	gls = GLS.getInstance()

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
			operator: "add",
			actor: receiver,
			amount: transaction.content.amount,
			hash: transaction.hash,
			nonce: transaction.content.nonce,
			timestamp: transaction.content.timestamp
		}
		gls.operations.push(operation)
        // Subtract value from sender's balance
		operation = {
			operator: "subtract",
            actor: sender,
            amount: transaction.content.amount,
            hash: transaction.hash,
            nonce: transaction.content.nonce,
            timestamp: transaction.content.timestamp
		}
		gls.operations.push(operation)
        success = true
        message = "Transaction successful"
        return [success, message]
    }

	// ANCHOR Managing complex operations
	if (transaction.content.data[0] === "execute") {
		// TODO Execute the code based on a currently not defined schema
	}

	return [success, message]
}