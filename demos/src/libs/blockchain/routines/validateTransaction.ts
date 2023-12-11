/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { cryptography } from "src/libs/crypto"
import Transaction from "../transaction"
import executeTransaction from "./executeTransaction"
import GLS from "../gls/gls"
import { Operation } from "../gls/gls"
import calculateCurrentGas from "./calculateCurrentGas"
var term = require("terminal-kit").terminal

// INFO Cryptographically validate a transaction, calculate gas and see if the execution is valid
// REVIEW is it overkill to write an interface for the return value?
export default async function validateTransaction(
    type: string,
    request: any, // Must contain a tx property being a Transaction object
): Promise<[boolean, any]> {
    term.yellow("Validating transaction...\n")

    // Loading identity
    const id_ed25519 = await cryptography.load("./.demos_identity")
    let publicKey = Buffer.from(id_ed25519.publicKey.toString("hex"))
    let privateKey = Buffer.from(id_ed25519.privateKey.toString("hex"))
    // Ingesting a transaction so that we have all the methods we need
    let tx = new Transaction()
    tx.content = request.tx.content
    tx.signature = request.tx.signature
    // As usual converting buffers to nodejs buffers
    if (
        typeof tx.signature === "object" &&
        request.tx.signature.type === "Buffer"
    ) {
        tx.signature = Buffer.from(request.tx.signature) as any
        console.log("Normalized signature")
    }
    console.log("Signature: ")
    console.log(tx.signature)
    tx.hash = request.tx.hash
    tx.confirmations = request.tx.confirmations
    tx.content.transaction_fee = request.tx.content.transaction_fee

    console.log("[TX RECEIVED] Examining:\n")
    console.log(tx)

    // NOTE Charge the gas for the transaction
    let from = tx.content.from.toString("hex")
    let fromBalance = 0
    try {
        fromBalance = await GLS.getGLSNativeBalance(from)
    } catch (e) {
        term.red.bold(
            "[NATIVE TX] [BALANCE ERROR] No balance found for this address: " +
                from +
                "\n",
        )
        return [
            false,
            "[NATIVE TX] [BALANCE ERROR] No balance found for this address: " +
                from +
                "\n",
        ]
    }
    // TODO Work on this method
    let gasAmount = await calculateCurrentGas(tx)
    if (fromBalance < gasAmount) {
        return [
            false,
            "[NATIVE TX] [BALANCE ERROR] Insufficient balance for gas; required: " +
                gasAmount +
                "\n",
        ]
    }
    // NOTE Deducting the gas from the account and assigning the operation to be executed
    // as child of this transaction
    let gas_operation: Operation = {
        operator: "pay_gas",
        actor: from,
        params: { amount: gasAmount.toString() },
        hash: tx.hash,
        nonce: tx.content.nonce,
        timestamp: tx.content.timestamp,
        status: "pending",
        fees: tx.content.transaction_fee,
    }
    console.log("[TX RECEIVED] Gas Operation derived\n")
    //console.log(gas_operation)
    // Verify tx validity
    let verified = Transaction.confirmTx(tx, privateKey, publicKey) // REVIEW Are the buffers ok?
    if (!verified) {
        return [false, "Transaction not verified: " + tx.hash]
    }
    // REVIEW Execute or Revert the transaction
    // NOTE executeTransaction returns an array of [success, message, operations]
    // The operations are the Operation objects that are executed in the GLS after the consensus
    // has confirmed the transaction in the block.
    let execution = await executeTransaction(tx)
    if (!execution[0]) {
        return [false, "Execution failed: " + execution[1]]
    }

    // ANCHOR TX Pre-execution, operation derivation and GLS Operation registry update are defined here

    // NOTE Now we can save the gas operation as the tx is set to be executed
    // and the gas will be deducted anyway
    GLS.getInstance().operations.push(gas_operation)
    // If the tx is valid and executable, we confirm it
    tx.confirmations.push(verified)
    // Finally, we add all the derived operations to the GLS
    for (let i = 0; i < execution[2].length; i++) {
        console.log("[TX RECEIVED] Operation derived")
        //console.log(execution[2][i])
        GLS.getInstance().operations.push(execution[2][i])
        console.log("[TX RECEIVED] Operation added to the GLS\n")
    }
    return [true, tx]
}
