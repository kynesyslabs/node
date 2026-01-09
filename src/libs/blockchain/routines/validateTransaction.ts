/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { pki } from "node-forge"
import Chain from "src/libs/blockchain/chain"
import GCR from "src/libs/blockchain/gcr/gcr"
import calculateCurrentGas from "src/libs/blockchain/routines/calculateCurrentGas"
import executeNativeTransaction from "src/libs/blockchain/routines/executeNativeTransaction"
import Transaction from "src/libs/blockchain/transaction"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import terminalkit from "terminal-kit"
import { Operation, ValidityData } from "@kynesyslabs/demosdk/types"
import { forgeToHex } from "src/libs/crypto/forgeUtils"
import _ from "lodash"
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
const term = terminalkit.terminal

// INFO Cryptographically validate a transaction and calculate gas
// REVIEW is it overkill to write an interface for the return value?
export async function confirmTransaction(
    tx: Transaction, // Must contain a tx property being a Transaction object
    sender: string,
): Promise<ValidityData> {
    term.yellow("\n[Native Tx Validation] Validating transaction...\n")
    // Getting the current block number
    const referenceBlock = await Chain.getLastBlockNumber()
    // REVIEW This should work just fine
    log.debug(`[TX] confirmTransaction - Signature: ${JSON.stringify(tx.signature)}`)
    log.debug(`[TX] confirmTransaction - Examining tx: ${JSON.stringify(tx)}`)
    // REVIEW Below: if this does not work, use ValidityData interface and fill manually
    let validityData: ValidityData = {
        data: {
            valid: false,
            reference_block: referenceBlock,
            message:
                "[Native Tx Validation] [NOT PROCESSED] Transaction yet to be processed\n",
            gas_operation: null,
            transaction: tx,
        },
        signature: null,
        rpc_public_key: {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(
                (await ucrypto.getIdentity(getSharedState.signingAlgorithm))
                    .publicKey as Uint8Array,
            ),
        },
    }
    /* REVIEW We are not using this method anymore, GCREdits take care of the gas operation
    let gas_operation: Operation
    let gas_calculus = await defineGas(tx, validityData, privateKey)
    // If we receive an Operation, we can continue
    // Else, we return the validity data with its error message
    // REVIEW We are checking against a known property to ensure we have either an Operation or a ValidityData
    if (gas_calculus[0]) {
        gas_operation = gas_calculus[1] as Operation
        validityData.data.gas_operation = gas_operation
    } else {
        validityData = gas_calculus[1] as ValidityData
        validityData = await signValidityData(validityData)
        return validityData
    }
    */

    /* NOTE Nonce assignment is done in the GCR too
    let hasNonce = await assignNonce(tx)
    if (!hasNonce) {
        validityData.data.message =
            "[Native Tx Validation] [NONCE ERROR] Nonce not assigned\n"
        validityData.data.valid = false
        validityData = await signValidityData(validityData)
        return validityData
    }
    */
    // Verify tx validity

    const {
        confirmation,
        message,
        success: verified,
    } = await Transaction.confirmTx(tx, sender) // REVIEW Are the buffers ok?

    if (!verified) {
        validityData.data.message =
            "[Tx Validation] [SIGNATURE ERROR] " + message + "\n"
        validityData.data.valid = false
        validityData = await signValidityData(validityData)
        return validityData
    }

    log.debug("[TX] confirmTransaction - Transaction validity verified, compiling ValidityData")
    validityData.data.message =
        "[Tx Validation] Transaction signature verified\n"
    validityData.data.valid = true
    validityData = await signValidityData(validityData)
    return validityData
}

async function signValidityData(data: ValidityData): Promise<ValidityData> {
    const hash = Hashing.sha256(JSON.stringify(data.data))
    // return data

    const signature = await ucrypto.sign(
        getSharedState.signingAlgorithm,
        new TextEncoder().encode(hash),
    )

    data.signature = {
        type: getSharedState.signingAlgorithm,
        data: uint8ArrayToHex(signature.signature),
    }
    return data
}

// This method is responsible for calculating the gas for a transaction and checking
// if the sender can afford it
async function defineGas(
    tx: Transaction,
    validityData: ValidityData,
    privateKey: pki.PrivateKey,
): Promise<[boolean, Operation | ValidityData]> {
    /* NOTE Charge the gas for the transaction
    This includes a check to see if the transaction gas can be paid
    by the sender prior to the transaction execution part.
    This way, we can avoid committing computations that will be reverted.
    */
    let from: string
    try {
        // REVIEW This could be legacy
        if (typeof tx.content.from === "string") {
            from = tx.content.from
        } else {
            from = forgeToHex(tx.content.from)
        }
        log.debug(`[TX] defineGas - Calculating gas for: ${from}`)
    } catch (e) {
        term.red.bold(
            "[Native Tx Validation] [FROM ERROR] No 'from' field found in the transaction\n",
        )
        validityData.data.message =
            "[Native Tx Validation] [FROM ERROR] No 'from' field found in the transaction\n"
        // Hash the validation data
        const hash = Hashing.sha256(JSON.stringify(validityData.data))
        // Sign the hash
        const signature = await ucrypto.sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(hash),
        )
        validityData.signature = {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(signature.signature),
        }
        return [false, validityData]
    }
    let fromBalance = 0
    try {
        fromBalance = await GCR.getGCRNativeBalance(from)
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
        const hash = Hashing.sha256(JSON.stringify(validityData.data))
        // Sign the hash
        const signature = await ucrypto.sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(hash),
        )
        validityData.signature = {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(signature.signature),
        }
    }
    // TODO Work on this method
    const compositeFeeAmount = await calculateCurrentGas(tx)
    // FIXME Overriding for testing
    if (fromBalance < compositeFeeAmount && getSharedState.PROD) {
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
        const hash = Hashing.sha256(JSON.stringify(validityData.data))
        // Sign the hash
        const signature = await ucrypto.sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(hash),
        )
        validityData.signature = {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(signature.signature),
        }
        return [false, validityData]
    }

    // TODO Move gas operation creator to a separate module
    // NOTE Deducting the gas from the account and assigning the operation to be executed
    // as child of this transaction
    const gasOperation: Operation = {
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
    log.debug("[TX] defineGas - Gas Operation derived")
    //console.log(gas_operation)
    return [true, gasOperation]
}

export async function assignNonce(tx: Transaction): Promise<boolean> {
    const validNonce = true // TODO Override for testing
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
    // The operations are the Operation objects that are executed in the GCR after the consensus
    // has confirmed the transaction in the block.

    const execution = await executeNativeTransaction(
        validityData.data.transaction,
    )
    if (!execution[0]) {
        return [false, "Execution failed: " + execution[1]]
    }

    // ANCHOR TX Pre-execution, operation derivation and GCR Operation registry update are defined here

    // NOTE Deprecated in favor of the GCREdit system
    // and the gas will be deducted anyway
    //console.log("[TX RECEIVED] Gas Operation added to the GCR\n")
    //GCR.getInstance().operations.push(validityData.data.gas_operation)

    // Finally, we add all the derived operations to the GCR
    // NOTE Deprecated in favor of GCREdit
    /*for (let i = 0; i < execution[2].length; i++) {
        console.log("[TX RECEIVED] Operation derived")
        //console.log(execution[2][i])
        GCR.getInstance().operations.push(execution[2][i])
        console.log("[TX RECEIVED] Operation added to the GCR\n")
    }*/
    return execution
}
