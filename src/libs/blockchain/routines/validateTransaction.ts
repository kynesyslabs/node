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
import Transaction from "src/libs/blockchain/transaction"
import Hashing from "src/libs/crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { Operation, ValidityData } from "@kynesyslabs/demosdk/types"
import { forgeToHex } from "src/libs/crypto/forgeUtils"
import _ from "lodash"
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import TxValidatorPool from "../validation/txValidatorPool"
import { isForkActive } from "@/forks"
import { applyGasFeeSeparation } from "@/libs/blockchain/routines/applyGasFeeSeparation"
import ensureGCRForUser from "@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser"
import type { GCRMain } from "@/model/entities/GCRv2/GCR_Main"

// INFO Cryptographically validate a transaction and calculate gas
// REVIEW is it overkill to write an interface for the return value?
export async function confirmTransaction(
    tx: Transaction, // Must contain a tx property being a Transaction object
    sender: string,
): Promise<ValidityData> {
    // Getting the current block number
    const getLastBlockNumberStart = Date.now()
    const referenceBlock = await Chain.getLastBlockNumber()
    const getLastBlockNumberEnd = Date.now()
    log.only(
        `[confirmTransaction] Get last block number in ${getLastBlockNumberEnd - getLastBlockNumberStart}ms`,
    )

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
        const feeBoundsResult = await applyGasFeeSeparation(tx)
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

async function signValidityData(data: ValidityData): Promise<ValidityData> {
    const hash = Hashing.sha256(JSON.stringify(data.data))
    // return data

    const signature = await TxValidatorPool.getInstance().sign(
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
        log.error(
            "TX",
            `[Native Tx Validation] [FROM ERROR] No 'from' field found in the transaction: ${errorMsg}`,
        )
        validityData.data.message =
            "[Native Tx Validation] [FROM ERROR] No 'from' field found in the transaction\n"
        // Hash the validation data
        const hash = Hashing.sha256(JSON.stringify(validityData.data))
        // Sign the hash
        const signature = await TxValidatorPool.getInstance().sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(hash),
        )
        validityData.signature = {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(signature.signature),
        }
        return [false, validityData]
    }
    // REVIEW getAccountBalance returns bigint; keep this binding bigint
    // to make the comparison against compositeFeeAmount (number) explicit
    // via BigInt() coercion below.
    let fromBalance = 0n
    try {
        fromBalance = await GCR.getAccountBalance(from)
    } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        log.error(
            "TX",
            `[Native Tx Validation] [BALANCE ERROR] No balance found for address ${from}: ${errorMsg}`,
        )
        validityData.data.message =
            "[Native Tx Validation] [BALANCE ERROR] No balance found for this address: " +
            from +
            "\n"
        // Hash the validation data
        const hash = Hashing.sha256(JSON.stringify(validityData.data))
        // Sign the hash
        const signature = await TxValidatorPool.getInstance().sign(
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
    // Audit-sweep batch B: dropped the `&& getSharedState.PROD` guard so the
    // balance check is enforced in every environment. The previous PROD-only
    // gate let non-prod nodes accept zero-balance transactions, which made
    // devnet/staging diverge from PROD validation semantics. Devnet now uses
    // a funded-genesis fixture, so unfunded broadcasts are no longer needed
    // for local testing.
    if (fromBalance < BigInt(compositeFeeAmount)) {
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
        const signature = await TxValidatorPool.getInstance().sign(
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

/**
 * Audit-sweep batch C — PR 1: nonce-validation infrastructure.
 *
 * Verifies an incoming transaction's `tx.content.nonce` against the
 * sender's current GCR account nonce. Fork-gated by `nonceEnforcement`:
 *
 *  - Pre-fork (legacy): always returns true; bit-identical to the
 *    previous hardcoded stub. Re-syncing pre-fork blocks is unaffected.
 *
 *  - Post-fork: returns true iff
 *      `tx.content.nonce === account.nonce + 1`.
 *    This PR (PR 1) is a single-tx check; PR 2 extends it to account
 *    for pending mempool txs from the same sender so back-to-back
 *    submissions from one address are accepted in order.
 *
 * The caller in `confirmTransaction` (lines 77-86) remains commented
 * out in PR 1 — this commit ships the validation infra without
 * wiring it into the live tx path. PR 3 uncomments the caller once
 * the consensus-side rejection (GCREdit `expectedPrior`) is in place,
 * so the validation and the apply-time check ship together behind
 * the same fork gate.
 *
 * Read-only: does not mutate `account.nonce`. The increment is emitted
 * as a `+1` nonce GCREdit by `HandleNativeOperations.handle()` in
 * PR 3, and applied at consensus time by `GCRNonceRoutines`.
 *
 * See `docs/specs/audit-sweep-batch-c-nonce.md` for the full design.
 */
export async function assignNonce(tx: Transaction): Promise<boolean> {
    const blockHeight =
        tx.blockNumber ?? getSharedState.lastBlockNumber ?? 0

    if (!isForkActive("nonceEnforcement", blockHeight)) {
        // Pre-fork: legacy accept-all behaviour. Preserves bit-identical
        // re-sync of every block authored before the fork activation.
        return true
    }

    const senderAddress: string =
        typeof tx.content.from === "string"
            ? tx.content.from
            : forgeToHex(tx.content.from)

    let account: GCRMain
    try {
        account = await ensureGCRForUser(senderAddress)
    } catch (e) {
        log.error(
            `[assignNonce] failed to load sender account for ${senderAddress}: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        return false
    }

    const txNonce = tx.content.nonce
    const expected = account.nonce + 1

    if (!Number.isInteger(txNonce) || txNonce !== expected) {
        log.error(
            `[assignNonce] nonce mismatch for ${senderAddress}: ` +
                `tx.content.nonce=${txNonce}, expected=${expected} ` +
                `(account.nonce=${account.nonce})`,
        )
        return false
    }

    return true
}
