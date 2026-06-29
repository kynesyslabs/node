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

import { GCREdit } from "@kynesyslabs/demosdk/types"
import type { Transaction as ITransaction } from "@kynesyslabs/demosdk/types"
import {
    calculateFeeBreakdown,
    type FeeBreakdown,
} from "@/libs/blockchain/routines/calculateCurrentGas"
import { generateFeeDistributionEdits } from "@/libs/blockchain/gcr/gcr_routines/feeDistribution"
import GCR from "@/libs/blockchain/gcr/gcr"
import { forgeToHex } from "@/libs/crypto/forgeUtils"

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
            return {
                ok: false,
                message: `calculateFeeBreakdown produced an invalid ${name}: ${value} (must be a non-negative integer; full breakdown: network_fee=${breakdown.network_fee}, rpc_fee=${breakdown.rpc_fee}, additional_fee=${breakdown.additional_fee}, total=${breakdown.total})`,
            }
        }
    }

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
    // wrong (Greptile P1 #2). The SDK ships the same component split the node
    // computes (network/rpc/additional), so a legit tx matches exactly; a
    // skewed or underpaid one is rejected. A DEM number is ×1e9 to OS; an OS
    // string is taken as-is.
    const toOs = (v: unknown): bigint => {
        if (typeof v === "string") return BigInt(v)
        return BigInt(Math.round(Number(v ?? 0))) * 1_000_000_000n
    }
    const componentChecks: Array<[string, unknown, number]> = [
        ["network_fee", shippedFee.network_fee, breakdown.network_fee],
        ["rpc_fee", shippedFee.rpc_fee, breakdown.rpc_fee],
        ["additional_fee", shippedFee.additional_fee, breakdown.additional_fee],
    ]
    for (const [name, shipped, computed] of componentChecks) {
        const shippedOs = toOs(shipped)
        const computedOs = BigInt(computed) * 1_000_000_000n
        if (shippedOs !== computedOs) {
            return {
                ok: false,
                message:
                    `transaction_fee.${name} mismatch: shipped=${String(shipped)} ` +
                    `(=${shippedOs} OS) but node computed ${computed} (=${computedOs} OS). ` +
                    "Refusing — fee underpayment / forged or skewed fee split.",
            }
        }
    }

    // Audit-sweep batch B: balance check is now enforced in every
    // environment. The previous PROD-only gate (paired with the same
    // gate in validateTransaction.defineGas, also dropped in this
    // batch) let non-prod nodes accept unfunded transactions, which
    // made devnet/staging diverge from PROD validation semantics.
    // Devnet uses a funded-genesis fixture, so unfunded broadcasts
    // are no longer needed for local testing.
    let senderBalance: bigint
    try {
        senderBalance = await GCR.getAccountBalance(senderAddress)
    } catch (e) {
        return {
            ok: false,
            message: `failed to read sender balance: ${
                e instanceof Error ? e.message : stringifyNonError(e)
            }`,
        }
    }
    if (senderBalance < BigInt(breakdown.total)) {
        return {
            ok: false,
            message: `sender balance ${senderBalance.toString()} < total fee ${breakdown.total}`,
        }
    }

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
