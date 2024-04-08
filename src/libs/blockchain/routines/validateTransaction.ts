/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { pki } from "node-forge"
import Chain from "src/libs/blockchain/chain"
import GLS from "src/libs/blockchain/gls/gls"
import { Operation } from "src/libs/blockchain/gls/types/Operations"
import calculateCurrentGas from "src/libs/blockchain/routines/calculateCurrentGas"
import executeNativeTransaction from "src/libs/blockchain/routines/executeNativeTransaction"
import Transaction from "src/libs/blockchain/transaction"
import { ValidityData } from "src/libs/blockchain/types/ValidityData"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import terminalkit from "terminal-kit"

const term = terminalkit.terminal


// INFO Cryptographically validate a transaction and calculate gas
// REVIEW is it overkill to write an interface for the return value?
export async function confirmTransaction(
    tx: Transaction, // Must contain a tx property being a Transaction object
): Promise<ValidityData> {
    term.yellow("[Native Tx Validation] Validating transaction...\n")
    // Getting the current block number
    let reference_block = await Chain.getLastBlockNumber()
    // Loading identity
    const id_ed25519 = await Cryptography.load("./.demos_identity")
    let publicKey = Buffer.from(id_ed25519.publicKey.toString("hex"))
    let privateKey = Buffer.from(id_ed25519.privateKey.toString("hex"))
    // REVIEW This should work just fine
    console.log("Signature: ")
    console.log(tx.signature)

    console.log("[Tx Validation] Examining it\n")
    console.log(tx)

    let validityData: ValidityData = {
        data: {
            valid: false,
            reference_block: reference_block,
            message: "",
            gas_operation: null,
            transaction: tx,
        },
        signature: null,
        rpc_public_key: publicKey,
    }

    /* NOTE Charge the gas for the transaction
    This includes a check to see if the transaction gas can be paid
    by the sender prior to the transaction execution part.
    This way, we can avoid committing computations that will be reverted.
    */
    let from = tx.content.from.toString("hex")
    let fromBalance = 0
    try {
        fromBalance = await GLS.getGLSNativeBalance(from)
    } catch (e) {
        term.red.bold(
            "[Native Tx Validation] [BALANCE ERROR] No balance found for this address: " +
                from +
                "\n",
        )
        validityData.data.message =
            "[Native Tx Validation] [BALANCE ERROR] No balance found for this address: " +
            from +
            "\n"
        // Hash the validation data
        let hash = Hashing.sha256(JSON.stringify(validityData.data))
        // Sign the hash
        validityData.signature = Cryptography.sign(hash, privateKey)
        return validityData
    }
    // TODO Work on this method
    let compositeFeeAmount = await calculateCurrentGas(tx)
    if (fromBalance < compositeFeeAmount) {
        term.red.bold(
            "[Native Tx Validation] [BALANCE ERROR] Insufficient balance for gas; required: " +
                compositeFeeAmount +
                "\n",
        )
        validityData.data.message =
            "[Native Tx Validation] [BALANCE ERROR] Insufficient balance for gas; required: " +
            compositeFeeAmount +
            "\n"
        // Hash the validation data
        let hash = Hashing.sha256(JSON.stringify(validityData.data))
        // Sign the hash
        validityData.signature = Cryptography.sign(hash, privateKey)
        return validityData
    }

    // TODO Move gas operation creator to a separate module
    // NOTE Deducting the gas from the account and assigning the operation to be executed
    // as child of this transaction
    let gas_operation: Operation = {
        operator: "pay_gas",
        actor: from,
        params: { amount: compositeFeeAmount.toString() },
        hash: tx.hash,
        nonce: tx.content.nonce,
        timestamp: tx.content.timestamp,
        status: "pending",
        fees: {
            network_fee: 0,
            rpc_fee: 0,
            additional_fee: 0,
        }, // This is the gas operation so it doesn't have additional fees
    }
    console.log("[Native Tx Validation] Gas Operation derived\n")
    //console.log(gas_operation)

    // Verify tx validity
    let verified = Transaction.confirmTx(tx, privateKey, publicKey) // REVIEW Are the buffers ok?
    if (!verified) {
        term.red.bold(
            "[Native Tx Validation] [SIGNATURE ERROR] Transaction signature not verified\n",
        )
        validityData.data.message =
            "[Native Tx Validation] [SIGNATURE ERROR] Transaction signature not verified\n"
        // Hash the validation data
        let hash = Hashing.sha256(JSON.stringify(validityData.data))
        // Sign the hash
        validityData.signature = Cryptography.sign(hash, privateKey)
        return validityData
    }

    // Now that we verified the transaction, we can return its validity data
    // TODO Add the relevant info
    validityData.data.valid = true
    validityData.data.message =
        "Transaction verified and ready to be executed\n"
    validityData.data.gas_operation = gas_operation
    // Hash the validation data
    let hash = Hashing.sha256(JSON.stringify(validityData.data))
    // Sign the hash
    validityData.signature = Cryptography.sign(hash, privateKey)
    return validityData
}

// TODO a verified transaction should be signed by the same rpc that verified it and should be only valid for the current consensus round
export async function broadcastVerifiedNativeTransaction(
    validityData: ValidityData,
): Promise<[boolean, string, Operation[]?]> {
    // REVIEW Execute or Revert the transaction
    // NOTE executeTransaction returns an array of [success, message, operations]
    // The operations are the Operation objects that are executed in the GLS after the consensus
    // has confirmed the transaction in the block.
    let execution = await executeNativeTransaction(validityData.data.transaction)
    if (!execution[0]) {
        return [false, "Execution failed: " + execution[1]]
    }

    // ANCHOR TX Pre-execution, operation derivation and GLS Operation registry update are defined here

    // NOTE Now we can save the gas operation as the tx is set to be executed
    // and the gas will be deducted anyway
    console.log("[TX RECEIVED] Gas Operation added to the GLS\n")
    GLS.getInstance().operations.push(validityData.data.gas_operation)

    // Finally, we add all the derived operations to the GLS
    for (let i = 0; i < execution[2].length; i++) {
        console.log("[TX RECEIVED] Operation derived")
        //console.log(execution[2][i])
        GLS.getInstance().operations.push(execution[2][i])
        console.log("[TX RECEIVED] Operation added to the GLS\n")
    }
    return execution
}
