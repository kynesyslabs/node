/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { pki } from "node-forge"
import Chain from "src/libs/blockchain/chain"
import GCR from "src/libs/blockchain/gcr/gcr"
import calculateCurrentGas, {
    calculateFeeBreakdown,
} from "src/libs/blockchain/routines/calculateCurrentGas"
import executeNativeTransaction from "src/libs/blockchain/routines/executeNativeTransaction"
import Transaction from "src/libs/blockchain/transaction"
import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { Operation, ValidityData } from "@kynesyslabs/demosdk/types"
import { forgeToHex } from "src/libs/crypto/forgeUtils"
import _ from "lodash"
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { isForkActive } from "@/forks"
import { generateFeeDistributionEdits } from "@/libs/blockchain/gcr/gcr_routines/feeDistribution"

// INFO Cryptographically validate a transaction and calculate gas
// REVIEW is it overkill to write an interface for the return value?
export async function confirmTransaction(
    tx: Transaction, // Must contain a tx property being a Transaction object
    sender: string,
): Promise<ValidityData> {
    log.info("TX", "[Native Tx Validation] Validating transaction...")
    // Getting the current block number
    const referenceBlock = await Chain.getLastBlockNumber()
    // REVIEW This should work just fine
    log.debug(
        `[TX] confirmTransaction - Signature: ${JSON.stringify(tx.signature)}`,
    )
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

    log.debug(
        "[TX] confirmTransaction - Transaction validity verified, compiling ValidityData",
    )
    validityData.data.message =
        "[Tx Validation] Transaction signature verified\n"
    validityData.data.valid = true

    // DEM-665 — gasFeeSeparation fee distribution.
    //
    // Post-fork the validating node computes the per-component fee
    // breakdown, stamps its own pubkey as `transaction_fee.rpc_address`
    // (so peers know where to route the rpc_fee share), checks the
    // sender can cover the total, and prepends the fee-distribution
    // GCREdits onto `tx.content.gcr_edits` so they apply before any
    // tx-level edits.
    //
    // Pre-fork: legacy path is preserved (the dead-code `defineGas`
    // function below is the historical placeholder). No edits emitted
    // here; the network keeps charging via the existing
    // calculateCurrentGas → defineGas → noop flow.
    //
    // The fee-distribution write MUST happen before
    // `signValidityData(validityData)` so the appended edits are part
    // of the signed hash (peers compute the same hash).
    if (isForkActive("gasFeeSeparation", referenceBlock)) {
        const feeBoundsResult = await applyGasFeeSeparation(tx, validityData)
        if (feeBoundsResult.ok === false) {
            validityData.data.valid = false
            validityData.data.message =
                "[Tx Validation] [FEE ERROR] " +
                feeBoundsResult.message +
                "\n"
            validityData = await signValidityData(validityData)
            return validityData
        }
    }

    // Must run before signValidityData(): any gcr_edit attached here
    // becomes part of the signed hash, so peers compute the same hash.
    let dispatchResult: { ok: true } | { ok: false; message: string }
    try {
        dispatchResult = await runTypeDispatcher(tx)
    } catch (e) {
        dispatchResult = {
            ok: false,
            message:
                "Dispatcher crashed: " +
                (e instanceof Error ? e.message : String(e)),
        }
    }
    if (dispatchResult.ok === false) {
        validityData.data.valid = false
        validityData.data.message =
            "[Tx Validation] [TYPE DISPATCH] " + dispatchResult.message + "\n"
        validityData = await signValidityData(validityData)
        return validityData
    }

    validityData = await signValidityData(validityData)
    return validityData
}

async function runTypeDispatcher(
    tx: Transaction,
): Promise<{ ok: true } | { ok: false; message: string }> {
    const type = (tx?.content?.type ?? "") as string
    if (
        type === "validatorStake" ||
        type === "validatorUnstake" ||
        type === "validatorExit"
    ) {
        const { handleStakingTx } = await import(
            "@/libs/network/routines/transactions/handleStakingTx"
        )
        const r = await handleStakingTx(tx as unknown as Parameters<
            typeof handleStakingTx
        >[0])
        return r.success ? { ok: true } : { ok: false, message: r.message }
    }
    if (type === "networkUpgrade" || type === "networkUpgradeVote") {
        const { handleGovernanceTx } = await import(
            "@/libs/network/routines/transactions/handleGovernanceTx"
        )
        const r = await handleGovernanceTx(tx as unknown as Parameters<
            typeof handleGovernanceTx
        >[0])
        return r.success ? { ok: true } : { ok: false, message: r.message }
    }
    return { ok: true }
}

/**
 * DEM-665 — compute the per-component fee breakdown, stamp
 * `transaction_fee.rpc_address` with this node's pubkey, check sender
 * balance, and prepend fee-distribution edits onto `tx.content.gcr_edits`.
 *
 * Called only when `isForkActive("gasFeeSeparation", currentBlock)` is
 * true. Mutates `tx` in place — the caller treats the mutation as
 * part of confirmation. Returns ok=true on success; ok=false with a
 * human-readable message when the sender cannot afford the total fee.
 *
 * Returns ok=true (no edits emitted) if the runtime
 * `feeDistribution` view is null. That state should never occur in
 * production once the fork is active — both bootstraps
 * (loadForkConfigFromGenesis + loadNetworkParameters) run before any
 * post-fork block is processed. The defensive path prefers
 * letting the tx through to a downstream apply-time failure rather
 * than rejecting valid txs because the loader had a transient hiccup.
 */
async function applyGasFeeSeparation(
    tx: Transaction,
    validityData: ValidityData,
): Promise<{ ok: true } | { ok: false; message: string }> {
    void validityData
    // Normalise sender pubkey to hex string; tx.content.from may be
    // either string or Uint8Array depending on entry point. Mirrors
    // the coercion in defineGas() below.
    let senderAddress: string
    try {
        senderAddress =
            typeof tx.content.from === "string"
                ? tx.content.from
                : forgeToHex(tx.content.from)
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
            ok: false,
            message: `failed to resolve sender address: ${msg}`,
        }
    }

    // Compute per-component breakdown.
    const breakdown = await calculateFeeBreakdown(tx)
    if (
        !Number.isFinite(breakdown.total) ||
        !Number.isInteger(breakdown.total) ||
        breakdown.total < 0
    ) {
        return {
            ok: false,
            message: `calculateFeeBreakdown returned non-integer total: ${breakdown.total}`,
        }
    }

    // Stamp the transaction with the per-component values + this
    // node's pubkey as the rpc_address. Peers receiving the signed
    // ValidityData rely on these fields being present.
    const rpcAddressHex = uint8ArrayToHex(
        (await ucrypto.getIdentity(getSharedState.signingAlgorithm))
            .publicKey as Uint8Array,
    )
    tx.content.transaction_fee.network_fee = breakdown.network_fee
    tx.content.transaction_fee.rpc_fee = breakdown.rpc_fee
    tx.content.transaction_fee.additional_fee = breakdown.additional_fee
    tx.content.transaction_fee.rpc_address = rpcAddressHex

    // Sender balance check — only enforced in PROD (matches the legacy
    // defineGas behavior so non-prod testing can submit unfunded txs).
    if (getSharedState.PROD) {
        let senderBalance: bigint
        try {
            senderBalance = await GCR.getGCRNativeBalance(senderAddress)
        } catch (e) {
            return {
                ok: false,
                message: `failed to read sender balance: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            }
        }
        if (senderBalance < BigInt(breakdown.total)) {
            return {
                ok: false,
                message: `sender balance ${senderBalance.toString()} < total fee ${breakdown.total}`,
            }
        }
    }

    // Generate fee-distribution edits and prepend onto the tx's
    // existing gcr_edits. Prepend (rather than append) so the fee
    // deductions apply before any tx-level operation — same intent as
    // the legacy gas-Operation slot.
    const feeEdits = generateFeeDistributionEdits({
        senderAddress,
        rpcAddress: rpcAddressHex,
        networkFee: breakdown.network_fee,
        rpcFee: breakdown.rpc_fee,
        additionalFee: breakdown.additional_fee,
        txHash: tx.hash ?? "",
        isRollback: false,
    })
    tx.content.gcr_edits = [
        ...(feeEdits as typeof tx.content.gcr_edits),
        ...(tx.content.gcr_edits ?? []),
    ]
    log.debug(
        `[TX] applyGasFeeSeparation - prepended ${feeEdits.length} fee edits onto tx ${tx.hash}`,
    )
    return { ok: true }
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
        const errorMsg = e instanceof Error ? e.message : String(e)
        log.error("TX", `[Native Tx Validation] [FROM ERROR] No 'from' field found in the transaction: ${errorMsg}`)
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
    // REVIEW getGCRNativeBalance returns bigint; keep this binding bigint
    // to make the comparison against compositeFeeAmount (number) explicit
    // via BigInt() coercion below.
    let fromBalance = 0n
    try {
        fromBalance = await GCR.getGCRNativeBalance(from)
    } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        log.error("TX", `[Native Tx Validation] [BALANCE ERROR] No balance found for address ${from}: ${errorMsg}`)
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
    // DEFENSIVE: `calculateCurrentGas` returns Promise<number>; if a future
    // Config / surge multiplier produces a non-finite or fractional value,
    // `BigInt(compositeFeeAmount)` would raise a generic RangeError inside
    // the validation critical path. Validate explicitly so the error
    // message names the offender and the validator-side caller can decide
    // what to do, rather than relying on the bare-bones BigInt error.
    // Currently `networkFee + rpcFee + burnFee = 1+1+1 = 3` so this guard
    // is dormant in production, but the bare BigInt cast was load-bearing
    // safety that needed naming.
    // myc#84, GH#3213220459
    if (
        !Number.isFinite(compositeFeeAmount) ||
        !Number.isInteger(compositeFeeAmount) ||
        compositeFeeAmount < 0
    ) {
        throw new Error(
            "[Native Tx Validation] calculateCurrentGas returned a value " +
                "that cannot be represented as a non-negative bigint: " +
                `${compositeFeeAmount} (typeof=${typeof compositeFeeAmount}). ` +
                "This indicates a Config / surge-multiplier producing a " +
                "fractional, NaN, Infinity, or negative fee — fees must be " +
                "non-negative integers in the active denomination.",
        )
    }
    // FIXME Overriding for testing
    if (fromBalance < BigInt(compositeFeeAmount) && getSharedState.PROD) {
        log.error(
            "TX",
            "[Native Tx Validation] [BALANCE ERROR] Insufficient balance for gas; required: " +
                compositeFeeAmount +
                "; available: " +
                fromBalance,
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
            // DEM-665: internal gas Operation; no rpc routing here.
            rpc_address: null,
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

    return execution
}
