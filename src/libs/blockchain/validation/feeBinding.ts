/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * The fee a native transaction ships against the fee the network charges.
 *
 * Apply derives the fee edits of a native transaction from its shipped
 * `transaction_fee`, so the shipped fee is what the sender pays. RPC confirm
 * has always compared it with the network's fee; the `feeBinding` fork makes
 * pool admission and apply compare it too, with this same function, so a
 * transaction that skipped the confirm step of an honest entry node pays the
 * same fee as one that did not.
 */

import type { GCREditBalance, Transaction } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "@/forks/forkGates"
import {
    calculateFeeBreakdown,
    type FeeBreakdown,
} from "@/libs/blockchain/routines/calculateCurrentGas"
import { generateNetworkFeeCredits } from "@/libs/blockchain/gcr/gcr_routines/feeDistribution"
import { getSharedState } from "@/utilities/sharedState"

type ShippedFee = NonNullable<Transaction["content"]["transaction_fee"]>

/**
 * A shipped fee value in OS: an OS string as is, a DEM number (the wire
 * shape before osDenomination) times 10^9.
 */
function toOs(value: unknown): bigint {
    if (typeof value === "string") return BigInt(value)
    return BigInt(Math.round(Number(value ?? 0))) * 1_000_000_000n
}

/**
 * Why the shipped fee is not the one `breakdown` charges, or null. Compared
 * per component: apply routes each component on its own, so a total that
 * matches with a skewed split would still route the fee wrongly.
 */
export function shippedFeeMismatch(
    shipped: ShippedFee,
    breakdown: FeeBreakdown,
): string | null {
    const components: Array<[string, unknown, number]> = [
        ["network_fee", shipped.network_fee, breakdown.network_fee],
        ["rpc_fee", shipped.rpc_fee, breakdown.rpc_fee],
        ["additional_fee", shipped.additional_fee, breakdown.additional_fee],
    ]
    for (const [name, value, computed] of components) {
        let computedOs: bigint
        try {
            computedOs = BigInt(computed) * 1_000_000_000n
        } catch {
            return `the network's ${name} is not an amount: ${String(computed)}`
        }
        let shippedOs: bigint
        try {
            shippedOs = toOs(value)
        } catch {
            return `transaction_fee.${name} is not an amount: ${String(value)}`
        }
        if (shippedOs !== computedOs) {
            return (
                `transaction_fee.${name} mismatch: shipped=${String(value)} ` +
                `(=${shippedOs} OS) but node computed ${computed} (=${computedOs} OS). ` +
                "Refusing — fee underpayment / forged or skewed fee split."
            )
        }
    }
    return null
}

/**
 * What apply deducts for a shipped fee component, in ledger units, or null
 * when apply could not charge it. Apply takes `Number(value)` as is and the
 * balance routine deducts that many ledger units (OS once osDenomination is
 * active, DEM before), so a DEM number after osDenomination pays a billionth
 * of the fee the hash commits to: the serializer hashes it as an OS string.
 */
function chargedAmount(value: unknown): bigint | null {
    if (value === null) return 0n
    if (typeof value === "string" && !/^(0|[1-9]\d*)$/.test(value)) return null
    if (typeof value !== "string" && typeof value !== "number") return null
    const charged = Number(value)
    return Number.isSafeInteger(charged) && charged >= 0 ? BigInt(charged) : null
}

/**
 * Why the fee apply would charge for `shipped` is not the one `breakdown`
 * charges, or null. Compared per component in ledger units, on the amount
 * apply deducts: the shape-free comparison of {@link shippedFeeMismatch}
 * reads a DEM number as DEM even where apply reads it as OS.
 */
export function chargedFeeMismatch(
    shipped: ShippedFee,
    breakdown: FeeBreakdown,
    postFork: boolean,
): string | null {
    const unit = postFork ? 1_000_000_000n : 1n
    const components: Array<[string, unknown, number]> = [
        ["network_fee", shipped.network_fee, breakdown.network_fee],
        ["rpc_fee", shipped.rpc_fee, breakdown.rpc_fee],
        ["additional_fee", shipped.additional_fee, breakdown.additional_fee],
    ]
    for (const [name, value, computed] of components) {
        let owed: bigint
        try {
            owed = BigInt(computed) * unit
        } catch {
            return `the network's ${name} is not an amount: ${String(computed)}`
        }
        const charged = chargedAmount(value)
        if (charged === null) {
            return `transaction_fee.${name} is not an amount apply can charge: ${String(value)}`
        }
        if (charged !== owed) {
            return (
                `transaction_fee.${name} mismatch: shipped=${String(value)} ` +
                `charges ${charged} but the network charges ${owed} ` +
                `(${postFork ? "OS" : "DEM"}). Refusing — fee underpayment / forged or skewed fee split.`
            )
        }
    }
    return null
}

/**
 * Why a native transaction's shipped fee is not the network's, or null.
 * Only native transactions are charged from `transaction_fee`, and only while
 * `gasFeeSeparation` is active, read from the same height the fee edits are
 * derived at. The rpc share is routed by the network, so a sender may not name
 * the account that receives it. `postFork` is the osDenomination state, which
 * sets the unit apply charges the fee in.
 */
export async function feeBindingRefusal(
    tx: Transaction,
    postFork: boolean,
): Promise<string | null> {
    if ((tx.content?.type as string) !== "native") return null
    if (!isForkActive("gasFeeSeparation", getSharedState.lastBlockNumber ?? 0)) {
        return null
    }
    const fee = tx.content.transaction_fee
    if (!fee) return "native transaction carries no transaction_fee"
    if (fee.rpc_address) {
        return "transaction_fee names an rpc_address; the sender does not route the rpc share"
    }
    return chargedFeeMismatch(fee, await calculateFeeBreakdown(tx), postFork)
}

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
 */
export function legacyGasCredited(tx: Pick<Transaction, "content">): boolean {
    const type = tx.content?.type as string
    if (type === "native" || type === "identity" || type === "d402_payment") {
        return false
    }
    const height = getSharedState.lastBlockNumber ?? 0
    return (
        isForkActive("gasFeeSeparation", height) &&
        isForkActive("feeBinding", height)
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
