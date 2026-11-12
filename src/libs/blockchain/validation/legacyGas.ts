/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * The SDK's flat gas edit under the fee forks: left out where the fee edits
 * replace it, credited where it is the whole fee. Kept apart from the fee
 * comparison in `feeBinding` so the edit check can read it without loading
 * the fee calculator and the database behind it.
 */

import type { GCREditBalance, Transaction } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "@/forks/forkGates"
import { generateNetworkFeeCredits } from "@/libs/blockchain/gcr/gcr_routines/feeDistribution"
import { getSharedState } from "@/utilities/sharedState"

/**
 * Whether a native transaction is charged its bound `transaction_fee` and
 * nothing else. Every SDK builder still ships the flat gas edit of the
 * lump-sum fee model, a sender debit that no edit credits. Under
 * `gasFeeSeparation` the derived fee edits are that fee, so applying the gas
 * as well charged the sender twice and took the gas out of the total supply
 * on every transfer. Gated on `feeBinding` too, read at the height the fee
 * edits are derived at, so a chain that ran `gasFeeSeparation` without it
 * replays the blocks it applied.
 */
export function legacyGasRetired(tx: Pick<Transaction, "content">): boolean {
    if ((tx.content?.type as string) !== "native") return false
    const height = getSharedState.lastBlockNumber ?? 0
    return (
        isForkActive("gasFeeSeparation", height) &&
        isForkActive("feeBinding", height)
    )
}

/**
 * Whether a non-native transaction's SDK gas edit is credited. The sender
 * still pays the gas as signed: only native transactions are charged from
 * `transaction_fee`, so for every other type the gas is its fee. Under the
 * same forks as {@link legacyGasRetired} that debit gets matching credits,
 * routed like a network fee, so no transaction takes DEM out of the total
 * supply. Identity and d402 transactions ship no gas.
 *
 * A Work replay is left as signed: it pays nothing (the Work it reads back
 * already paid), so its gas is never charged and there is nothing to credit,
 * and a replay that carries a credit is refused as a transfer.
 */
export function legacyGasCredited(tx: Pick<Transaction, "content">): boolean {
    const type = tx.content?.type as string
    if (type === "native" || type === "identity" || type === "d402_payment") {
        return false
    }
    if (isWorkReplay(tx.content?.gcr_edits)) return false
    const height = getSharedState.lastBlockNumber ?? 0
    return (
        isForkActive("gasFeeSeparation", height) &&
        isForkActive("feeBinding", height)
    )
}

/** Whether `edits` read back a Work that already ran, which pays no fee. */
export function isWorkReplay(edits: ReadonlyArray<{ type: string }> | undefined): boolean {
    return (edits ?? []).some(
        e =>
            e.type === "work-attempt" &&
            (e as unknown as { attemptClass?: unknown }).attemptClass === "replay",
    )
}

/**
 * Whether a native TLSNotary request or store has its burn credited. The SDK
 * builds that burn as a sender debit that no edit credits; under the forks
 * that retire the gas ({@link legacyGasRetired}) it gets credits routed like a
 * network fee, as the gas of other types does, while the sender still pays
 * it as signed.
 */
export function tlsnBurnCredited(tx: Pick<Transaction, "content">): boolean {
    if (!legacyGasRetired(tx)) return false
    const data = tx.content?.data as unknown as [string, { nativeOperation?: unknown }] | undefined
    const operation = data?.[1]?.nativeOperation
    return operation === "tlsn_request" || operation === "tlsn_store"
}

/**
 * Where the sender debit right before the trailing nonce edit sits in
 * `edits`, or -1. In an SDK-built set that is the gas edit; once the gas is
 * left out of a TLSNotary operation, it is the burn.
 */
function trailingDebitIndex(edits: Array<{ type: string }>): number {
    const last = edits.length - 1
    if (last < 1) return -1
    const nonce = edits[last] as unknown as { type: string; account?: unknown }
    const debit = edits[last - 1] as unknown as {
        type: string
        operation?: unknown
        account?: unknown
    }
    if (nonce.type !== "nonce" || debit.type !== "balance") return -1
    if (debit.operation !== "remove" || debit.account !== nonce.account) return -1
    return last - 1
}

/**
 * `edits` without the SDK gas edit. Edits of any other shape come back as
 * the same array.
 */
export function withoutLegacyGas<T extends { type: string }>(edits: T[]): T[] {
    const at = trailingDebitIndex(edits)
    if (at < 0) return edits
    return [...edits.slice(0, at), ...edits.slice(at + 1)]
}

/**
 * The credits for a signed sender debit, in the ledger units apply deducts
 * it in, or none for an amount apply could not deduct either.
 */
export function debitCredits(debit: { amount?: unknown }, txHash: string): GCREditBalance[] {
    const amount = Number(debit.amount)
    if (!Number.isSafeInteger(amount) || amount <= 0) return []
    return generateNetworkFeeCredits(amount, txHash, false)
}

/**
 * `edits` with the credits of the sender debit right before the nonce edit
 * placed right after that debit: the gas of a non-native transaction, or the
 * burn of a TLSNotary operation whose gas was left out. A set that already
 * carries them has a credit, not the debit, before its nonce edit, so it
 * comes back as the same array, as does a set without such a debit.
 */
export function withTrailingDebitCredit<T extends { type: string }>(
    edits: T[],
    txHash: string,
): T[] {
    const at = trailingDebitIndex(edits)
    if (at < 0) return edits
    const credits = debitCredits(edits[at] as unknown as { amount?: unknown }, txHash)
    if (credits.length === 0) return edits
    return [
        ...edits.slice(0, at + 1),
        ...(credits as unknown as T[]),
        ...edits.slice(at + 1),
    ]
}
