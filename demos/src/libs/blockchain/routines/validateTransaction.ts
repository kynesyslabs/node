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

// INFO Cryptographically validate a transaction, calculate gas and see if the execution is valid
export default async function validateTransaction(
    type: string,
    request: any,
): Promise<Transaction> {
    // Loading identity
    const id_ed25519 = await cryptography.load("./.demos_identity")
    let publicKey = Buffer.from(id_ed25519.publicKey.toString("hex"))
    let privateKey = Buffer.from(id_ed25519.privateKey.toString("hex"))
    // Ingesting a transaction so that we have all the methods we need
    let tx = new Transaction()
    tx.content = request.tx.content
    tx.signature = request.tx.signature
    tx.hash = request.tx.hash
    tx.confirmations = request.tx.confirmations
    tx.state_changes = request.tx.state_changes
    tx.content.transaction_fee = request.tx.content.transaction_fee
    // NOTE Charge the gas for the transaction
    let from = request.tx.from.toString("hex")
    let fromBalance = await GLS.getGLSNativeBalance(from)
    let gasAmount = await calculateCurrentGas(tx)
    if (fromBalance < gasAmount) {
        return null // No gas money? No transaction!
    }
    // Deducting the gas from the account
    let operation: Operation = {
        operator: "pay_gas",
        actor: from,
        amount: gasAmount,
        hash: tx.hash,
        nonce: tx.content.nonce,
        timestamp: tx.content.timestamp,
        status: "pending",
        fees: tx.content.transaction_fee,
    }
    GLS.getInstance().operations.push(operation)
    // Verify tx validity
    let verified = Transaction.confirmTx(tx, privateKey, publicKey) // REVIEW Are the buffers ok?
    if (!verified) {
        return null
    }
    // REVIEW Execute or Revert the transaction
    let execution = await executeTransaction(tx)
    if (!execution[0]) {
        return null
    }
    // If the tx is valid and executable, we confirm it
    tx.confirmations.push(verified)
    return tx
}
