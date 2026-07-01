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
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import TxValidatorPool from "../validation/txValidatorPool"
import { isForkActive } from "@/forks"
import { applyGasFeeSeparation } from "@/libs/blockchain/routines/applyGasFeeSeparation"
import Mempool from "@/libs/blockchain/mempool"
import ParallelNetworks from "@/libs/l2ps/parallelNetworks"
import { checkInnerTxBalance } from "@/libs/l2ps/balanceCheck"
import { normalizePubkey } from "../gcr/handleGCR"

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
            data: getSharedState.publicKeyHex,
        },
    }

    const { message, success: verified } = await Transaction.confirmTx(
        tx,
        sender,
    )

    if (!verified) {
        validityData.data.message =
            "[Tx Validation] [SIGNATURE ERROR] " + message + "\n"
        validityData.data.valid = false
        validityData = await signValidityData(validityData)
        return validityData
    }

    // Check if the transaction status is set
    if (tx.status) {
        validityData.data.message =
            "[Tx Validation] [STATUS ERROR] Transaction status should be nullish. Got: <" +
            typeof(tx.status) +
            ">" +
            tx.status +
            "\n"
        validityData.data.valid = false
        validityData = await signValidityData(validityData)
        return validityData
    }

    // Check nonce > current nonce
    const currentNonce = await GCR.getAccountNonce(
        normalizePubkey(tx.content.from_ed25519_address || tx.content.from),
    )

    if (tx.content.nonce <= currentNonce) {
        validityData.data.message =
            "[Tx Validation] [NONCE ERROR] Transaction nonce error. Expected >=" +
            (currentNonce + 1) +
            ", got: " +
            tx.content.nonce +
            "\n"
        validityData.data.valid = false
        validityData = await signValidityData(validityData)
        return validityData
    }

    log.debug(
        "[TX] confirmTransaction - Transaction validity verified, compiling ValidityData",
    )

    // Confirm that nonce gcr_edit increments the nonce by exactly 1
    const nonceEdit = tx.content.gcr_edits.find(edit => edit.type === "nonce")
    if (nonceEdit) {
        if (nonceEdit.amount !== 1) {
            validityData.data.message =
                "[Tx Validation] [NONCE ERROR] Nonce edit amount must be 1, got: " +
                nonceEdit.amount +
                "\n"
            validityData.data.valid = false
            validityData = await signValidityData(validityData)
            return validityData
        }
    }

    // Check tx in transaction table
    const dbTx = await Chain.getTransactionFromHash(tx.hash)
    if (dbTx) {
        validityData.data.message =
            "[Tx Validation] [TX EXISTS ERROR] Transaction already executed in block number: " +
            dbTx.blockNumber
        validityData.data.valid = false
        validityData = await signValidityData(validityData)
        return validityData
    }

    // Check tx in mempool
    const mempoolTx = await Mempool.checkTransactionByHash(tx.hash)
    if (mempoolTx) {
        validityData.data.message =
            "[Tx Validation] [TX EXISTS ERROR] Transaction already in mempool\n"
        validityData.data.valid = false
        validityData = await signValidityData(validityData)
        return validityData
    }

    let txAmount: bigint

    try {
        txAmount = BigInt(tx.content.amount ?? 0)
    } catch (e) {
        validityData.data.message = `[Tx Validation] [AMOUNT ERROR] Invalid tx amount ${JSON.stringify(tx.content.amount)}: ${(e as Error).message}\n`
        validityData.data.valid = false
        validityData = await signValidityData(validityData)
        return validityData
    }

    if (txAmount > 0n) {
        const from =
            typeof tx.content.from === "string"
                ? tx.content.from
                : forgeToHex(tx.content.from)

        const fromBalance = await GCR.getAccountBalance(from)
        if (fromBalance < txAmount) {
            validityData.data.message = `[Tx Validation] [BALANCE ERROR] Insufficient balance: need ${txAmount} but have ${fromBalance}\n`
            validityData.data.valid = false
            validityData = await signValidityData(validityData)
            return validityData
        }
    }

    // For L2PS encrypted transactions, decrypt inner tx and check balance
    if (tx.content.type === "l2psEncryptedTx") {
        const l2psBalanceError = await checkL2PSBalance(tx)
        if (l2psBalanceError) {
            validityData.data.message = l2psBalanceError
            validityData.data.valid = false
            validityData = await signValidityData(validityData)
            return validityData
        }
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
                "[Tx Validation] [FEE ERROR] " + feeBoundsResult.message + "\n"
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
        const { handleStakingTx } =
            await import("@/libs/network/routines/transactions/handleStakingTx")
        const r = await handleStakingTx(
            tx as unknown as Parameters<typeof handleStakingTx>[0],
        )
        return r.success ? { ok: true } : { ok: false, message: r.message }
    }
    if (type === "networkUpgrade" || type === "networkUpgradeVote") {
        const { handleGovernanceTx } =
            await import("@/libs/network/routines/transactions/handleGovernanceTx")
        const r = await handleGovernanceTx(
            tx as unknown as Parameters<typeof handleGovernanceTx>[0],
        )
        return r.success ? { ok: true } : { ok: false, message: r.message }
    }
    return { ok: true }
}

/**
 * Decrypt L2PS encrypted tx and check inner tx balance before mempool.
 *
 * Returns error string on any "cannot verify" outcome rather than null;
 * `confirmTransaction` reads null as "balance OK" and would otherwise
 * sign ValidityData claiming the tx is valid even though we never
 * actually verified it — a fail-open hole.
 *
 * The amount + fee comparison is delegated to `checkInnerTxBalance`,
 * the same helper `handleL2PS.checkSenderBalance` uses, so both call
 * sites canonicalise units identically against the OS-magnitude
 * balance (the previous DEM-vs-OS mismatch made the gate a silent
 * no-op post-osDenomination fork).
 */
async function checkL2PSBalance(tx: Transaction): Promise<string | null> {
    try {
        const l2psPayload = (tx.content?.data as any)?.[1]
        const l2psUid = l2psPayload?.l2ps_uid as string | undefined
        if (!l2psUid) {
            return "[Tx Validation] [BALANCE ERROR] L2PS transaction missing l2ps_uid — cannot verify sender balance\n"
        }

        const parallelNetworks = ParallelNetworks.getInstance()
        let l2psInstance = await parallelNetworks.getL2PS(l2psUid)
        if (!l2psInstance) {
            l2psInstance = await parallelNetworks.loadL2PS(l2psUid)
        }
        if (!l2psInstance) {
            return `[Tx Validation] [BALANCE ERROR] L2PS network ${l2psUid} is not loaded on this node — cannot verify sender balance\n`
        }

        const decryptedTx = await l2psInstance.decryptTx(tx as any)
        if (!decryptedTx?.content?.from) {
            return "[Tx Validation] [BALANCE ERROR] L2PS payload decryption produced no sender — cannot verify balance\n"
        }

        const innerError = await checkInnerTxBalance(decryptedTx as Transaction)
        if (innerError) return `[Tx Validation] [BALANCE ERROR] ${innerError}\n`
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error(
            `[confirmTransaction] L2PS balance pre-check error: ${message}`,
        )
        // Fail closed — see fn docstring.
        return `[Tx Validation] [BALANCE ERROR] L2PS balance pre-check failed: ${message}\n`
    }
    return null
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
