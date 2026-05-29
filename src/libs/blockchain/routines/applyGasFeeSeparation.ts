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
 *   3. (PROD only) Reads the sender's GCR balance and rejects if it is
 *      below the total fee.
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
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { calculateFeeBreakdown } from "@/libs/blockchain/routines/calculateCurrentGas"
import { generateFeeDistributionEdits } from "@/libs/blockchain/gcr/gcr_routines/feeDistribution"
import GCR from "@/libs/blockchain/gcr/gcr"
import { forgeToHex } from "@/libs/crypto/forgeUtils"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"

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

    // Audit-sweep batch B: assert components sum to total so any rounding
    // bug or config drift in calculateFeeBreakdown is caught here instead
    // of as a validator-side consensus disagreement.
    const componentSum =
        breakdown.network_fee + breakdown.rpc_fee + breakdown.additional_fee
    if (componentSum !== breakdown.total) {
        return {
            ok: false,
            message: `calculateFeeBreakdown components do not sum to total: network_fee=${breakdown.network_fee} + rpc_fee=${breakdown.rpc_fee} + additional_fee=${breakdown.additional_fee} = ${componentSum}, expected ${breakdown.total}`,
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

    // PR #817 Greptile P1 (silent fee bypass):
    // generateFeeDistributionEdits returns [] when
    // `requireFeeDistribution` returns null — either feeDistribution
    // hasn't been primed at all, or every percentage is still 0
    // (transient window between loadForkConfigFromGenesis and
    // loadNetworkParameters). Silently accepting the tx in that
    // window would charge nothing while marking the tx valid, which
    // is exactly the failure mode the prior guard was meant to
    // prevent. Refuse the tx whenever the breakdown demanded a
    // non-zero total but no edits were generated.
    if (breakdown.total > 0 && feeEdits.length === 0) {
        return {
            ok: false,
            message:
                "fee distribution not primed — refusing to accept post-fork tx without fee collection " +
                `(breakdown.total=${breakdown.total}, but generateFeeDistributionEdits returned 0 edits)`,
        }
    }

    tx.content.gcr_edits = [
        ...(feeEdits as GCREdit[]),
        ...((tx.content.gcr_edits ?? []) as GCREdit[]),
    ]
    log.debug(
        `[TX] applyGasFeeSeparation - prepended ${feeEdits.length} fee edits onto tx ${tx.hash}`,
    )
    return { ok: true }
}
