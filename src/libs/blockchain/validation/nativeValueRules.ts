/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * Rules on what a transaction pays, judged on its signed body, where the edit
 * binding alone does not reach:
 *  - `nativeSendBinding`: the edits of a native send are regenerated from its
 *    payload args, while receipts, explorers and the RPC balance check read
 *    `content.to` and `content.amount`; the two must name one payment.
 *  - `canonicalAddresses`: the ledger keys an account by its exact string, so
 *    an upper-case spelling of an address is another account, one no wallet
 *    reads.
 *  - `feeBinding`: a native transaction ships the network's fee.
 *
 * Pool admission and apply run them, each behind its fork, read from the
 * chain tip like `editBinding`. RPC confirm runs the first two whatever the
 * forks say: refusing there changes only what this node accepts.
 */

import type { Transaction } from "@kynesyslabs/demosdk/types"
import { canonicalizeAmountToOs } from "@/forks/amountCanonical"
import { feeBindingRefusal } from "./feeBinding"

export interface ValueRules {
    sendBound: boolean
    canonical: boolean
    feeBound: boolean
    /** osDenomination, which sets the unit amounts are paid and named in. */
    postFork: boolean
}

/**
 * The ledger units a send's args pay, or null. Apply credits args[1] as is,
 * so a number pays that many OS once osDenomination is active.
 */
function paidAmount(value: unknown): bigint | null {
    if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null
    if (typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value)) return BigInt(value)
    return null
}

/**
 * The ledger units content.amount names, or null: what the signature hash
 * and the RPC balance check read, where a DEM number becomes OS once
 * osDenomination is active.
 */
function namedAmount(value: unknown, postFork: boolean): bigint | null {
    if (typeof value !== "number" && typeof value !== "string") return null
    try {
        return canonicalizeAmountToOs(value, postFork)
    } catch {
        return null
    }
}

function nativeSendArgs(tx: Transaction): unknown[] | null | undefined {
    if ((tx.content?.type as string) !== "native") return undefined
    const payload = (tx.content.data as unknown as [string, Record<string, unknown>] | undefined)?.[1]
    if (!payload || payload.nativeOperation !== "send") return undefined
    return Array.isArray(payload.args) ? payload.args : null
}

/**
 * Why a native send pays another recipient or amount than its body names, or
 * null. The amounts are compared in ledger units, not as written: after
 * osDenomination a body amount of 1 names 1 DEM while args of 1 pay 1 OS.
 */
export function nativeSendRefusal(tx: Transaction, postFork: boolean): string | null {
    const args = nativeSendArgs(tx)
    if (args === undefined) return null
    if (args === null || args.length !== 2) return "native send args must be [to, amount]"
    if (typeof args[0] !== "string" || args[0] !== tx.content.to) {
        return "native send pays another recipient than content.to"
    }
    const paid = paidAmount(args[1])
    const named = namedAmount(tx.content.amount, postFork)
    if (paid === null || named === null || paid !== named) {
        return "native send pays another amount than content.amount"
    }
    return null
}

const ACCOUNT = /^0x[0-9a-f]{64}$/
const HEX = /^(0x)?[0-9a-f]+$/i

function upperCaseHex(value: unknown): boolean {
    return typeof value === "string" && HEX.test(value) && value !== value.toLowerCase()
}

/**
 * Why a transaction names an account by a non-canonical spelling, or null:
 * its sender, the recipient of a native send (which must be a full lowercase
 * address), the account its fee names for the rpc share, or the account of a
 * balance edit it ships.
 */
export function nonCanonicalAddressRefusal(tx: Transaction): string | null {
    const content = tx.content as unknown as Record<string, unknown>
    if (upperCaseHex(content.from) || upperCaseHex(content.from_ed25519_address)) {
        return "sender address is not lowercase hex"
    }
    const args = nativeSendArgs(tx)
    if (args !== undefined) {
        const to = args?.[0]
        if (typeof to !== "string" || !ACCOUNT.test(to)) {
            return "native send recipient is not a lowercase 0x-prefixed 32-byte hex address"
        }
    }
    const fee = content.transaction_fee as { rpc_address?: unknown } | null | undefined
    if (upperCaseHex(fee?.rpc_address)) return "transaction_fee.rpc_address is not lowercase hex"
    const edits = (tx.content?.gcr_edits ?? []) as unknown as Array<Record<string, unknown>>
    for (const edit of edits) {
        if (edit?.type === "balance" && upperCaseHex(edit.account)) {
            return "balance edit account is not lowercase hex"
        }
    }
    return null
}

/** The rules active for this block, in the order they are judged. */
export async function valueRulesRefusal(
    tx: Transaction,
    rules: ValueRules,
): Promise<string | null> {
    if (rules.canonical) {
        const reason = nonCanonicalAddressRefusal(tx)
        if (reason) return reason
    }
    if (rules.sendBound) {
        const reason = nativeSendRefusal(tx, rules.postFork)
        if (reason) return reason
    }
    if (rules.feeBound) {
        const reason = await feeBindingRefusal(tx, rules.postFork)
        if (reason) return reason
    }
    return null
}
