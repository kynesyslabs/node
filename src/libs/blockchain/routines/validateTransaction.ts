/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { pki } from "node-forge"
import Chain from "src/libs/blockchain/chain"
import GLS from "src/libs/blockchain/gls/gls"
import calculateCurrentGas from "src/libs/blockchain/routines/calculateCurrentGas"
import executeNativeTransaction from "src/libs/blockchain/routines/executeNativeTransaction"
import Transaction from "src/libs/blockchain/transaction"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import sharedState from "src/utilities/sharedState"
import terminalkit from "terminal-kit"

import { Operation, ValidityData, CValidityData } from "@kynesyslabs/demosdk/types"
import required from "src/utilities/required"
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
    let publicKey = id_ed25519.publicKey
    let privateKey = id_ed25519.privateKey
    // REVIEW This should work just fine
    console.log("Signature: ")
    console.log(tx.signature)

    console.log("[Tx Validation] Examining it\n")
    console.log(tx)
    // REVIEW Below: if this does not work, use ValidityData interface and fill manually
    let validityData = new CValidityData(
        tx,
        publicKey as pki.ed25519.BinaryBuffer,
        reference_block,
    )
    let gas_operation: Operation
    let gas_calculus = await defineGas(tx, validityData, privateKey)
    // If we receive an Operation, we can continue
    // Else, we return the validity data with its error message
    // REVIEW We are checking against a known property to ensure we have either an Operation or a ValidityData
    try {
        gas_operation = gas_calculus as Operation
        required(gas_operation.hash)
    } catch (e) {
        validityData = gas_calculus as ValidityData
        return CValidityData.compile(
            validityData,
            validityData.data.message,
            privateKey as pki.ed25519.BinaryBuffer,
            false,
        )
    }
    let hasNonce = await assignNonce(tx)
    if (!hasNonce) {
        return CValidityData.compile(
            validityData,
            "[Native Tx Validation] [NONCE ERROR] Nonce not assigned to the transaction\n",
            privateKey as pki.ed25519.BinaryBuffer,
            false,
        )
    }
    // Verify tx validity
    let verified = Transaction.confirmTx(
        tx,
        privateKey as pki.ed25519.BinaryBuffer,
        publicKey as pki.ed25519.BinaryBuffer,
    ) // REVIEW Are the buffers ok?
    if (!verified) {
        return CValidityData.compile(
            validityData,
            "[Native Tx Validation] [SIGNATURE ERROR] Transaction signature not verified\n",
            privateKey as pki.ed25519.BinaryBuffer,
            false,
        )
    }
    console.log(
        "[Native Tx Validation] Transaction validity verified, compiling ValidityData\n",
    )
    return CValidityData.compile(
        validityData,
        "[Native Tx Validation] Transaction validity verified",
        privateKey as pki.ed25519.BinaryBuffer,
        true,
    )
}

// This method is responsible for calculating the gas for a transaction and checking
// if the sender can afford it
async function defineGas(
    tx: Transaction,
    validityData: ValidityData,
    privateKey: pki.PrivateKey,
): Promise<Operation | ValidityData> {
    /* NOTE Charge the gas for the transaction
    This includes a check to see if the transaction gas can be paid
    by the sender prior to the transaction execution part.
    This way, we can avoid committing computations that will be reverted.
    */
    let from: string
    try {
        from = tx.content.from.toString("hex")
        console.log(
            "[Native Tx Validation] Calculating gas for: " + from + "\n",
        )
    } catch (e) {
        term.red.bold(
            "[Native Tx Validation] [FROM ERROR] No 'from' field found in the transaction\n",
        )
        validityData.data.message =
            "[Native Tx Validation] [FROM ERROR] No 'from' field found in the transaction\n"
        // Hash the validation data
        let hash = Hashing.sha256(JSON.stringify(validityData.data))
        // Sign the hash
        validityData.signature = Cryptography.sign(hash, privateKey)
        return validityData
    }
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
    // FIXME Overriding for testing
    if (fromBalance < compositeFeeAmount && sharedState.getInstance().PROD) {
        term.red.bold(
            "[Native Tx Validation] [BALANCE ERROR] Insufficient balance for gas; required: " +
                compositeFeeAmount +
                "; available: " +
                fromBalance +
                "\n" +
                "\n",
        )
        validityData.data.message =
            "[Native Tx Validation] [BALANCE ERROR] Insufficient balance for gas; required: " +
            compositeFeeAmount +
            "; available: " +
            fromBalance +
            "\n" +
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
}

export async function assignNonce(tx: Transaction): Promise<Boolean> {
    let validNonce = true // TODO Override for testing
    // TODO Get, check and increment the nonce of the transaction
    // while returning either true or false
    return validNonce
}

// TODO a verified transaction should be signed by the same rpc that verified it and should be only valid for the current consensus round
export async function broadcastVerifiedNativeTransaction(
    validityData: ValidityData,
): Promise<[boolean, string, Operation[]?]> {
    // REVIEW Execute or Revert the transaction
    // NOTE executeTransaction returns an array of [success, message, operations]
    // The operations are the Operation objects that are executed in the GLS after the consensus
    // has confirmed the transaction in the block.

    let execution = await executeNativeTransaction(
        validityData.data.transaction,
    )
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
