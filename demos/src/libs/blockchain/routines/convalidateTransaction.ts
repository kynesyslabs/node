/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { cryptography } from "src/libs/crypto"
import Transaction from "../transaction"
import executeTransaction from "./executeTransaction"

// INFO Cryptographically convalidate a transaction and see if the execution is valid
export default async function convalidateTransaction(request: any): Promise<Transaction> {
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
    // TODO Lock the fee and write somewhere that it has to be returned (db: table transactions -> return_fee) (tx.content.lock_fee)
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
