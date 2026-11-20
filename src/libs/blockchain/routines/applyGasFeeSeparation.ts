/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * DEM-665 — Gas Fee Separation tx-confirmation hook.
 *
 * Called by `validateTransaction.confirmTransaction` when the
 * `gasFeeSeparation` fork is active at the current reference block.
 * Does four things:
 *
 *   1. Computes the per-component fee breakdown via
 *      {@link calculateFeeBreakdown}.
 *   2. Stamps `tx.content.transaction_fee.{network_fee, rpc_fee,
 *      additional_fee, rpc_address}` with the breakdown values + this
 *      node's signing pubkey. Peers verifying the signed ValidityData
 *      rely on those fields being present.
 *   3. Reads the sender's GCR balance and rejects if it is below the
 *      total fee. Enforced in every environment as of audit-sweep
 *      batch B (the previous PROD-only gate let non-prod nodes accept
 *      unfunded transactions, which made devnet diverge from PROD).
 *   4. Generates the fee-distribution GCREdits via
 *      {@link generateFeeDistributionEdits} and prepends them onto
 *      `tx.content.gcr_edits` so the fee deductions apply before any
 *      tx-level operation.
 *
 * Mutates `tx` in place. Returns `{ ok: true }` on success or
 * `{ ok: false, message }` on failure; the caller signs the failure
 * into the outgoing ValidityData.
 *
 * Extracted from `validateTransaction.ts` (DEM-665 P10c) so it can be
 * unit-tested directly without mocking the full `confirmTransaction`
 * surface (which pulls in Chain, GCR, forgeToHex,
 * Transaction.confirmTx, every signing helper, ...). The signature is
 * deliberately self-contained: every external dependency goes through
 * an import that can be jest-mocked.
 */

import { denomination } from "@kynesyslabs/demosdk"
import { GCREdit } from "@kynesyslabs/demosdk/types"
import type { Transaction as ITransaction } from "@kynesyslabs/demosdk/types"
import {
    calculateFeeBreakdown,
    type FeeBreakdown,
} from "@/libs/blockchain/routines/calculateCurrentGas"
import { generateFeeDistributionEdits } from "@/libs/blockchain/gcr/gcr_routines/feeDistribution"
import GCR from "@/libs/blockchain/gcr/gcr"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import { isForkActive } from "@/forks/forkGates"
import { getSharedState } from "@/utilities/sharedState"
import {
    chargedFeeMismatch,
    shippedFeeMismatch,
} from "@/libs/blockchain/validation/feeBinding"
import {
    legacyGasRetired,
    withoutLegacyGas,
} from "@/libs/blockchain/validation/legacyGas"
import { generateGcrEdits } from "@/libs/blockchain/validation/generateGcrEdits"

/**
 * What the block debits the sender of a native transaction besides its fee
 * edits, in ledger units, and the account it debits: the sender's debits
 * among the edits regenerated from the signed body, which the block binds the
 * shipped edits to, less the retired gas edit. A send debits its amount, a
 * TLSNotary request or store its special-operation burn. The sender is the
 * account of the nonce edit, the ed25519 identity, which for a PQC-signed
 * transaction is not the `from` the fee edits debit.
 */
async function nativeSenderDebit(
    tx: ApplyGasFeeSeparationTx,
    postFork: boolean,
): Promise<{ account: string; amount: bigint }> {
    const regenerated = withoutLegacyGas(await generateGcrEdits(tx as ITransaction))
    const serialised = denomination.serializeTransactionContent(
        { gcr_edits: regenerated } as never,
        postFork,
    )
    const edits = (JSON.parse(serialised).gcr_edits ?? []) as Array<Record<string, unknown>>
    const sender = edits.findLast(e => e.type === "nonce")?.account
    let debit = 0n
    for (const edit of edits) {
        if (edit.type !== "balance" || edit.operation !== "remove") continue
        if (edit.account !== sender) continue
        debit += BigInt(edit.amount as string | number)
    }
    return { account: typeof sender === "string" ? sender : "", amount: debit }
}

export type ApplyGasFeeSeparationResult =
    | { ok: true }
    | { ok: false; message: string }

/**
 * Stringify a thrown non-Error value for inclusion in a diagnostic
 * message. `String(obj)` yields `[object Object]` for plain objects;
 * `JSON.stringify` preserves the shape. Falls back to the bare
 * default if JSON serialisation itself throws (cyclic graphs, BigInt
 * outside JSON.rawJSON, etc.) so the diagnostic path never re-throws.
 */
function stringifyNonError(e: unknown): string {
    try {
        return JSON.stringify(e)
    } catch {
        return String(e)
    }
}

/**
 * Minimal view of the Transaction surface that this routine touches.
 * Accepts both the SDK ITransaction shape and the node-side Transaction
 * subclass — only the fields listed here are read or written.
 */
export type ApplyGasFeeSeparationTx = Pick<
    ITransaction,
    "content" | "hash"
>

/** Why a fee component is not a non-negative integer, or null when none is. */
function breakdownRefusal(breakdown: FeeBreakdown): string | null {
    const components: Array<[keyof FeeBreakdown, number]> = [
        ["network_fee", breakdown.network_fee],
        ["rpc_fee", breakdown.rpc_fee],
        ["additional_fee", breakdown.additional_fee],
        ["total", breakdown.total],
    ]
    for (const [name, value] of components) {
        if (
            !Number.isFinite(value) ||
            !Number.isInteger(value) ||
            value < 0
        ) {
            return `calculateFeeBreakdown produced an invalid ${name}: ${value} (must be a non-negative integer; full breakdown: network_fee=${breakdown.network_fee}, rpc_fee=${breakdown.rpc_fee}, additional_fee=${breakdown.additional_fee}, total=${breakdown.total})`
        }
    }
    return null
}

/** An account's balance, or why it could not be read. */
async function readBalance(account: string): Promise<{ balance: bigint } | { error: string }> {
    try {
        return { balance: await GCR.getAccountBalance(account) }
    } catch (e) {
        return {
            error: `failed to read sender balance: ${
                e instanceof Error ? e.message : stringifyNonError(e)
            }`,
        }
    }
}

/**
 * Why the sender cannot pay what the block will debit it, or null when it can.
 */
async function balanceRefusal(
    tx: ApplyGasFeeSeparationTx,
    senderAddress: string,
    breakdown: FeeBreakdown,
): Promise<string | null> {
    const sender = await readBalance(senderAddress)
    if ("error" in sender) return sender.error
    if (legacyGasRetired(tx)) {
        return retiredGasBalanceRefusal(tx, senderAddress, sender.balance, breakdown)
    }
    const fee = feeInLedgerUnits(tx, breakdown.total)
    return sender.balance < fee
        ? `sender balance ${sender.balance.toString()} < total fee ${fee.toString()}`
        : null
}

/** A fee total in the units apply deducts it in: OS for a native fee after osDenomination. */
function feeInLedgerUnits(tx: ApplyGasFeeSeparationTx, total: number): bigint {
    return BigInt(total) *
        ((tx.content.type as string) === "native" &&
        isForkActive("osDenomination", getSharedState.lastBlockNumber ?? 0) ? 1_000_000_000n : 1n)
}

/**
 * Where the fee edits are the whole fee (legacyGasRetired), the block debits
 * the fee and the transaction's own debits in ledger units and nothing else,
 * so each account must hold what it is debited: the fee from `from`, the
 * amount (a TLSNotary operation's burn) from the nonce-edit account, both
 * from one account when they are the same. Before, the amount alone was
 * checked, and the fee was compared as a DEM count against an OS balance.
 */
async function retiredGasBalanceRefusal(
    tx: ApplyGasFeeSeparationTx,
    senderAddress: string,
    senderBalance: bigint,
    breakdown: FeeBreakdown,
): Promise<string | null> {
    const postFork = isForkActive("osDenomination", getSharedState.lastBlockNumber ?? 0)
    const fee = BigInt(breakdown.total) * (postFork ? 1_000_000_000n : 1n)
    let debit: { account: string; amount: bigint }
    try {
        debit = await nativeSenderDebit(tx, postFork)
    } catch (e) {
        return `cannot compute what the block debits the sender: ${
            e instanceof Error ? e.message : stringifyNonError(e)
        }`
    }
    if (debit.amount === 0n || debit.account.toLowerCase() === senderAddress.toLowerCase()) {
        return senderBalance < debit.amount + fee
            ? `sender balance ${senderBalance.toString()} < amount ${debit.amount.toString()} + fee ${fee.toString()}`
            : null
    }
    if (senderBalance < fee) {
        return `sender balance ${senderBalance.toString()} < fee ${fee.toString()}`
    }
    const payer = await readBalance(debit.account)
    if ("error" in payer) return payer.error
    return payer.balance < debit.amount
        ? `balance of ${debit.account} ${payer.balance.toString()} < amount ${debit.amount.toString()}`
        : null
}

export async function applyGasFeeSeparation(
    tx: ApplyGasFeeSeparationTx,
): Promise<ApplyGasFeeSeparationResult> {
    // Normalise sender pubkey to hex string; tx.content.from may be
    // either string or Uint8Array depending on entry point. Mirrors
    // the coercion in the legacy defineGas() path.
    let senderAddress: string
    try {
        senderAddress =
            typeof tx.content.from === "string"
                ? tx.content.from
                : forgeToHex(tx.content.from)
    } catch (e) {
        // CodeRabbit PR #817: `String(e)` on a plain object collapses
        // to `[object Object]` which kills debuggability when a
        // non-Error gets thrown from forgeToHex. Fall back to
        // JSON.stringify so the structured value survives in logs.
        const msg = e instanceof Error ? e.message : stringifyNonError(e)
        return {
            ok: false,
            message: `failed to resolve sender address: ${msg}`,
        }
    }

    // Compute per-component breakdown.
    const breakdown = await calculateFeeBreakdown(tx)

    // Audit-sweep batch B: validate every fee component independently.
    // calculateFeeBreakdown derives `total` as the direct sum of the
    // three component locals, so asserting `total` alone, or asserting
    // components-sum === total, is tautological with the current
    // implementation. The real failure surface is each component
    // becoming NaN / Infinity / negative / fractional via the
    // `scalar * surge` multiplication: a misconfigured scalar
    // (negative governance proposal, accidental float coefficient) or
    // a broken `dynamicSurgeMultiplier` will produce one or more bad
    // components, which then propagate into `tx.content.transaction_fee`
    // and the fee-distribution edits and finally surface as
    // validator-side consensus disagreement. Validate each component
    // here so the tx is rejected at the RPC boundary with an
    // actionable per-component message instead.
    const invalid = breakdownRefusal(breakdown)
    if (invalid) return { ok: false, message: invalid }

    // Epic #21 #204: do NOT mutate tx.content. Stamping transaction_fee
    // and prepending fee edits AFTER the SDK signed the tx broke
    // validateTxCoherence on the gossip path (derived hash != signed
    // tx.hash) -> peers reject as "not coherent" -> divergent blocks ->
    // permanent vote split -> chain frozen on any tx. The fee edits are
    // now derived deterministically AT APPLY from the SDK-shipped
    // transaction_fee (see deriveFeeEditsForApply in handleGCR), so the
    // gossiped tx stays byte-identical to what the sender signed. This
    // routine no longer writes to `tx`; it ENFORCES the shipped fee (below)
    // and does the balance pre-check.

    // Greptile P1 (epic #21 #204): because the fee is now charged at apply
    // from the SDK-shipped transaction_fee — NOT from the node-computed
    // `breakdown` — a client could ship `{network_fee:0, rpc_fee:0,
    // additional_fee:0}` and pass ingress while paying nothing. Bind the
    // shipped fee to the canonical breakdown here: reject any tx whose
    // shipped components don't match what the node computes. Compared in OS
    // via toOsBigint (the shipped value is a DEM number pre-serialize or an
    // OS string post-serialize; breakdown is in the same base unit the SDK
    // signs), so the check is unit-robust. Without this the fee floor is
    // unenforced.
    const shippedFee = tx.content.transaction_fee
    if (!shippedFee) {
        return {
            ok: false,
            message:
                "post-gasFeeSeparation tx is missing transaction_fee — refusing (cannot bind shipped fee to breakdown)",
        }
    }
    // Bind the shipped fee PER-COMPONENT to the node-computed breakdown, in
    // OS. Per-component (not just total) because the fee is charged at apply
    // from the shipped components (deriveFeeEditsForApply) — binding only the
    // total would let a client skew the split (e.g. put everything in
    // network_fee, rpc_fee=0) and pass validation while the apply-time
    // distribution emits no RPC-fee block, making fee routing deterministically
    // wrong (Greptile P1 #2). A native fee is charged at apply in ledger units
    // as shipped, so it is compared on what apply deducts, as pool admission
    // and apply compare it under feeBinding.
    const mismatch =
        (tx.content.type as string) === "native"
            ? chargedFeeMismatch(
                  shippedFee,
                  breakdown,
                  isForkActive("osDenomination", getSharedState.lastBlockNumber ?? 0),
              )
            : shippedFeeMismatch(shippedFee, breakdown)
    if (mismatch) return { ok: false, message: mismatch }
    // The rpc share of a native fee goes to the account the shipped fee names,
    // and the SDK names none; a sender naming one would route it to itself.
    if ((tx.content.type as string) === "native" && shippedFee.rpc_address) {
        return {
            ok: false,
            message:
                "transaction_fee names an rpc_address; the sender does not route the rpc share",
        }
    }

    // Audit-sweep batch B: balance check is now enforced in every
    // environment. The previous PROD-only gate (paired with the same
    // gate in validateTransaction.defineGas, also dropped in this
    // batch) let non-prod nodes accept unfunded transactions, which
    // made devnet/staging diverge from PROD validation semantics.
    // Devnet uses a funded-genesis fixture, so unfunded broadcasts
    // are no longer needed for local testing.
    const unfunded = await balanceRefusal(tx, senderAddress, breakdown)
    if (unfunded) return { ok: false, message: unfunded }

    // Epic #21 #204: fee edits are NO LONGER prepended here. They are
    // derived at apply (deriveFeeEdits in handleGCR) from the SDK-shipped
    // transaction_fee so every node applies an identical set without
    // mutating the signed tx. We still fail closed at ingress if fees are
    // owed but the distribution config isn't primed, to preserve the
    // "never silently accept a no-fee post-fork tx" guard.
    if (breakdown.total > 0) {
        const probe = generateFeeDistributionEdits({
            senderAddress,
            rpcAddress: null,
            networkFee: breakdown.network_fee,
            rpcFee: breakdown.rpc_fee,
            additionalFee: breakdown.additional_fee,
            txHash: tx.hash ?? "",
            isRollback: false,
        })
        if (probe.length === 0) {
            return {
                ok: false,
                message:
                    "fee distribution not primed — refusing to accept post-fork tx without fee collection " +
                    `(breakdown.total=${breakdown.total}, but generateFeeDistributionEdits returned 0 edits)`,
            }
        }
    }
    return { ok: true }
}
