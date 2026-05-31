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
import Datasource from "@/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import Mempool from "@/libs/blockchain/mempool"

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

    // Audit-sweep batch C PR 3 — wire `assignNonce` into the live
    // validation path. Pre-fork: `assignNonce` short-circuits to
    // `true` (PR 1), so this is a noop. Post-fork: enforces strict
    // sequential nonce semantics with mempool lookahead (PRs 1+2),
    // and the matching consensus-side `expectedPrior` check on
    // `GCRNonceRoutines` (this PR) is the cross-RPC safety net.
    const hasNonce = await assignNonce(tx)
    if (!hasNonce) {
        validityData.data.message =
            "[Native Tx Validation] [NONCE ERROR] Nonce not assigned\n"
        validityData.data.valid = false
        validityData = await signValidityData(validityData)
        return validityData
    }

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
 * Audit-sweep batch C — PR 1 + PR 2: nonce-validation with mempool lookahead.
 *
 * Verifies an incoming transaction's `tx.content.nonce` against the
 * sender's current GCR account nonce, plus the count of txs from the
 * same sender already queued in this node's mempool. Fork-gated by
 * `nonceEnforcement`:
 *
 *  - Pre-fork (legacy): always returns true; bit-identical to the
 *    previous hardcoded stub. Re-syncing pre-fork blocks is unaffected.
 *
 *  - Post-fork: returns true iff
 *      `tx.content.nonce === account.nonce + 1 + pendingMempoolCount`.
 *    The mempool count lets a sender submit N transactions in a row
 *    while account.nonce has not yet advanced — each successive
 *    submission expects a higher nonce. PR 3 wires the consensus-side
 *    `expectedPrior` check that prevents cross-RPC double-submission
 *    where a peer's mempool count diverges from this node's.
 *
 * Concurrency caveat (TOCTOU). On a single node, two concurrent
 * submissions from the same sender both read `pendingCount` before
 * either is admitted to the mempool, so both compute the same
 * `expected` and both pass validation. PR 2 explicitly does NOT
 * close this window. The fix lands in PR 3 alongside the caller
 * wire-up, where the validate+`Mempool.addTransaction` sequence
 * is wrapped in a per-sender critical section (Postgres advisory
 * lock keyed by `hashtext(sender)`, released at commit). Today the
 * caller is commented out so the race is unreachable; the
 * surrounding lock is part of the PR 3 design lock-in
 * (see `docs/specs/audit-sweep-batch-c-nonce.md` — Risks section).
 *
 * The caller in `confirmTransaction` (lines 77-86) remains commented
 * out in PR 1 — this commit ships the validation infra without
 * wiring it into the live tx path. PR 3 uncomments the caller once
 * the consensus-side rejection (GCREdit `expectedPrior`) is in place,
 * so the validation and the apply-time check ship together behind
 * the same fork gate.
 *
 * Strictly read-only against the GCR. Uses a direct `findOne` lookup
 * rather than `ensureGCRForUser` so an unknown sender pubkey cannot
 * provision a phantom account row as a side effect of nonce
 * validation (PR #884 review: Greptile P1 / CodeRabbit Critical). The
 * increment side is shipped by PR 3 as a `+1` nonce GCREdit emitted
 * from `HandleNativeOperations.handle()` and applied by
 * `GCRNonceRoutines` at consensus time.
 *
 * Fork-gate block height is read from `getSharedState.lastBlockNumber`
 * only — never from the tx, which is attacker-controlled on the
 * ingress path (PR #884 review: CodeRabbit Critical).
 *
 * See `docs/specs/audit-sweep-batch-c-nonce.md` for the full design.
 */
export async function assignNonce(tx: Transaction): Promise<boolean> {
    // Greptile + CodeRabbit PR #884 feedback: fork gating must use
    // node-local chain state only. `tx.blockNumber` is attacker-
    // controlled on the ingress path (the caller is RPC-facing), so
    // pinning to it would let a forged tx select a pre-fork height
    // and bypass enforcement once the caller is uncommented in PR 3.
    //
    // The tx is destined for the next block (`lastBlockNumber + 1`).
    // Using `lastBlockNumber` here is slightly conservative at the
    // exact activation boundary — if `activationHeight ===
    // lastBlockNumber + 1`, the gate reads inactive at ingress but
    // active at inclusion. PR 3's consensus-side `expectedPrior`
    // check is the safety net for that one-block window.
    const blockHeight = getSharedState.lastBlockNumber ?? 0

    if (!isForkActive("nonceEnforcement", blockHeight)) {
        // Pre-fork: legacy accept-all behaviour. Preserves bit-identical
        // re-sync of every block authored before the fork activation.
        return true
    }

    // CodeRabbit feedback: canonicalise to lowercase so submissions
    // that differ only in casing target the same GCR row. The wire
    // pubkey format is lowercase hex by convention, but we don't
    // want validation to depend on caller discipline.
    const senderAddressRaw: string =
        typeof tx.content.from === "string"
            ? tx.content.from
            : forgeToHex(tx.content.from)
    const senderAddress = senderAddressRaw.toLowerCase()

    // Greptile P1 feedback: must be a pure read. The previous draft
    // used `ensureGCRForUser`, which calls `HandleGCR.createAccount`
    // for unknown pubkeys. Once the caller is uncommented in PR 3,
    // validation runs before signature verification, so any
    // syntactically valid `from` could provision a phantom account
    // (DB bloat + free side-effect ahead of crypto check). Use a
    // direct repository lookup and treat unknown sender as invalid
    // nonce — a real sender that has never transacted has
    // `account.nonce === 0`, so they were created at genesis or by
    // a prior received tx; never having a row means they can't have
    // a valid nonce to submit either.
    let account: GCRMain | null
    try {
        const db = await Datasource.getInstance()
        const gcrRepository = db.getDataSource().getRepository(GCRMain)
        account = await gcrRepository.findOne({
            where: { pubkey: senderAddress },
        })
    } catch (e) {
        log.error(
            `[assignNonce] failed to load sender account for ${senderAddress}: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        return false
    }

    if (!account) {
        log.error(
            `[assignNonce] no GCR account for sender ${senderAddress} — ` +
                "rejecting nonce check",
        )
        return false
    }

    // Audit-sweep batch C PR 2: account for txs already queued in
    // mempool from the same sender. PR 1 enforced a strict
    // `account.nonce + 1` equality, which rejected back-to-back
    // submissions (the second tx still reads `account.nonce` because
    // the first has not yet been included in a block, so both would
    // claim the same nonce). Adding the pending-queue depth lets a
    // sender submit N transactions in a row: the k-th submission
    // expects `account.nonce + 1 + (k-1)`. The k-th tx is itself
    // not yet in the mempool at this point, hence the `+ 1` for the
    // current tx.
    //
    // Single-node correctness only: another node sees its own
    // mempool, which may not contain the same pending set. PR 3's
    // consensus-side `expectedPrior` check is the cross-node
    // safety net — at block-application time, only one of any pair
    // of competing same-nonce txs survives.
    let pendingCount: number
    try {
        pendingCount = await Mempool.countPendingByAddress(senderAddress)
    } catch (e) {
        log.error(
            `[assignNonce] failed to count mempool txs for ${senderAddress}: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        return false
    }

    const txNonce = tx.content.nonce
    const expected = account.nonce + 1 + pendingCount

    if (!Number.isInteger(txNonce) || txNonce !== expected) {
        log.error(
            `[assignNonce] nonce mismatch for ${senderAddress}: ` +
                `tx.content.nonce=${txNonce}, expected=${expected} ` +
                `(account.nonce=${account.nonce}, ` +
                `pendingMempoolCount=${pendingCount})`,
        )
        return false
    }

    // Audit-sweep batch C PR 3 — populate `expectedPrior` on this
    // tx's `nonce` GCREdit (if present) at validation time, NOT at
    // apply time.
    //
    // Why validation time: the value must be a snapshot of the
    // sender's nonce taken BEFORE this tx is bundled into a block.
    // Populating at apply time would re-read `entities.accounts` —
    // which already reflects prior in-block applies — so the
    // expected value would track the apply-time state, defeating
    // the cross-RPC safety net entirely (the second replay would
    // see its own freshly-incremented value and pass the check).
    //
    // Formula: `expectedPrior = account.nonce + pendingCount`. This
    // is the value the sender's nonce will be at the moment this tx
    // applies, assuming all queued mempool txs from the same sender
    // (which are ordered before this one) land first. For a single
    // tx: `pendingCount === 0`, so `expectedPrior === account.nonce`.
    // For the k-th of N back-to-back submissions:
    // `expectedPrior === account.nonce + (k-1)`.
    //
    // The field is stripped from both sides of the hash compare in
    // `endpointValidation`, so the signed tx hash is invariant under
    // whether or not this populate ran. Pre-fork blocks re-sync
    // bit-identically because the fork-gate above short-circuits.
    //
    // We mutate `tx.content.gcr_edits` in place. The hash strip
    // means downstream serialisation / signing is unaffected.
    if (Array.isArray(tx.content.gcr_edits)) {
        const expectedPrior = account.nonce + pendingCount
        for (const edit of tx.content.gcr_edits) {
            if (edit.type === "nonce") {
                const editAccount =
                    typeof edit.account === "string"
                        ? edit.account.toLowerCase()
                        : edit.account
                if (editAccount === senderAddress) {
                    edit.expectedPrior = expectedPrior
                }
            }
        }
    }

    return true
}
