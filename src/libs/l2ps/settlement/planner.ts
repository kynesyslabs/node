/**
 * Picks the transfers of one batch and computes its net changes against the
 * given balances. Deterministic: the same transfers, balances and nonces give
 * the same plan on every member.
 */
import {
    AMOUNT_LIMIT,
    NONCE_LIMIT,
    SETTLEMENT_ACCOUNTS,
    SETTLEMENT_TRANSFERS,
    accountLimbs,
    compareAccounts,
    settlementCommitment,
} from "./encoding"
import type { DecryptedTransfer, SettlementChange, SettlementPlan } from "./types"

/** Why a transfer stays out of this batch. Stable strings: logs and tests match on them. */
export const DEFER_REASON = {
    batchFull: "batch already holds the maximum number of transfers",
    accountsFull: "batch already touches the maximum number of accounts",
    invalidTransfer: "transfer fields are out of range or malformed",
    commitmentMismatch: "commitment does not open to the transfer",
    nonce: "nonce is not the signer's next",
    overdraft: "sender balance does not cover amount plus fee at this point in the batch",
    overflow: "a balance would reach 2^128",
} as const

function wellFormed(t: DecryptedTransfer): boolean {
    try {
        accountLimbs(t.from)
        accountLimbs(t.to)
    } catch {
        return false
    }
    return (
        typeof t.amount === "bigint" && t.amount >= 0n && t.amount < AMOUNT_LIMIT &&
        typeof t.fee === "bigint" && t.fee >= 0n && t.fee < AMOUNT_LIMIT &&
        typeof t.nonce === "bigint" && t.nonce >= 0n && t.nonce < NONCE_LIMIT &&
        typeof t.salt === "bigint" && typeof t.commitment === "bigint"
    )
}

// A transfer whose commitment does not open would only make the proof fail.
function commitmentOpens(t: DecryptedTransfer): boolean {
    try {
        return settlementCommitment(t) === t.commitment
    } catch {
        return false
    }
}

/**
 * Takes transfers in the given order and keeps each one that, applied after
 * the ones already kept, carries the signer's next nonce, does not overdraft
 * the sender (debit amount + fee, then credit amount, as the circuit does),
 * keeps every balance below 2^128 and fits the slots. A deferred transfer
 * changes nothing, so the transfers after it are judged as if it were absent.
 *
 * @param balances current L1 balance per account; a missing account holds 0
 * @param nonces current L1 nonce per account; a missing account has nonce 0
 */
export function planSettlement(
    transfers: DecryptedTransfer[],
    balances: Map<string, bigint>,
    nonces: Map<string, bigint>,
): SettlementPlan {
    const kept: DecryptedTransfer[] = []
    const deferred: SettlementPlan["deferred"] = []
    const before = new Map<string, bigint>()
    const running = new Map<string, bigint>()
    const nextNonce = new Map<string, bigint>()

    const balanceOf = (account: string): bigint =>
        running.get(account) ?? balances.get(account) ?? 0n

    for (const t of transfers) {
        const defer = (reason: string) => deferred.push({ transfer: t, reason })

        if (kept.length >= SETTLEMENT_TRANSFERS) {
            defer(DEFER_REASON.batchFull)
            continue
        }
        if (!wellFormed(t)) {
            defer(DEFER_REASON.invalidTransfer)
            continue
        }
        if (!commitmentOpens(t)) {
            defer(DEFER_REASON.commitmentMismatch)
            continue
        }
        const expected = nextNonce.get(t.from) ?? (nonces.get(t.from) ?? 0n) + 1n
        if (t.nonce !== expected) {
            defer(DEFER_REASON.nonce)
            continue
        }
        const added = [...new Set([t.from, t.to])].filter(a => !before.has(a))
        if (before.size + added.length > SETTLEMENT_ACCOUNTS) {
            defer(DEFER_REASON.accountsFull)
            continue
        }

        const senderBefore = balanceOf(t.from)
        const receiverBefore = balanceOf(t.to)
        // The circuit cannot hold a balance outside [0, 2^128).
        if (
            senderBefore < 0n || senderBefore >= AMOUNT_LIMIT ||
            receiverBefore < 0n || receiverBefore >= AMOUNT_LIMIT
        ) {
            defer(DEFER_REASON.overflow)
            continue
        }
        const senderAfter = senderBefore - t.amount - t.fee
        if (senderAfter < 0n) {
            defer(DEFER_REASON.overdraft)
            continue
        }
        // Credit after debit: a self-transfer credits the already debited sender.
        const receiverAfter = (t.to === t.from ? senderAfter : receiverBefore) + t.amount
        if (receiverAfter >= AMOUNT_LIMIT) {
            defer(DEFER_REASON.overflow)
            continue
        }

        for (const a of added) before.set(a, balances.get(a) ?? 0n)
        running.set(t.from, senderAfter)
        running.set(t.to, receiverAfter)
        nextNonce.set(t.from, t.nonce + 1n)
        kept.push(t)
    }

    const accounts = [...before.keys()].sort(compareAccounts)
    const changes: SettlementChange[] = accounts.map(account => ({
        account,
        delta: (running.get(account) as bigint) - (before.get(account) as bigint),
    }))
    const balancesBefore = new Map(accounts.map(a => [a, before.get(a) as bigint]))
    return { transfers: kept, deferred, changes, balancesBefore }
}
