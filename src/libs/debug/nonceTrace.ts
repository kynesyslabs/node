import { GCREditNonce } from "@kynesyslabs/demosdk/types"

import log from "src/utilities/logger"
import Transaction from "src/libs/blockchain/transaction"
import { Config } from "@/config"
import GCR from "@/libs/blockchain/gcr/gcr"
import { normalizeAccount } from "@/libs/l2ps/editConservation"

export const NONCE_TRACE_ATTR_KEY = "nonceTrace"

export interface NonceTraceEntry {
    startFilter: number
    projectedEnd: number
    startApply: number
    endApply: number
}

export type NonceTrace = Record<string, NonceTraceEntry>

export function debugAssertionsEnabled(): boolean {
    return Config.getInstance().debug.assertionsEnabled
}

export async function readNonces(
    accounts: string[],
): Promise<Record<string, number>> {
    if (accounts.length === 0) return {}
    return await GCR.getAccountNonces(accounts)
}

function nonceEdits(tx: Transaction): GCREditNonce[] {
    return (tx.content.gcr_edits ?? []).filter(
        (edit): edit is GCREditNonce => edit.type === "nonce",
    )
}

export function collectNonceAccounts(txs: Transaction[]): Set<string> {
    const accounts = new Set<string>()
    for (const tx of txs) {
        for (const edit of nonceEdits(tx)) {
            accounts.add(normalizeAccount(edit.account))
        }
    }
    return accounts
}

/**
 * Sum the net nonce change each account would receive from the given txs,
 * mirroring GCRNonceRoutines: `add` credits the amount, `remove` debits it.
 */
export function sumNonceDeltas(txs: Transaction[]): Record<string, number> {
    const deltas: Record<string, number> = {}
    for (const tx of txs) {
        for (const edit of nonceEdits(tx)) {
            const account = normalizeAccount(edit.account)
            const amount = edit.operation === "remove" ? -edit.amount : edit.amount
            deltas[account] = (deltas[account] ?? 0) + amount
        }
    }
    return deltas
}

export function buildNonceTrace(
    accounts: Iterable<string>,
    startFilter: Record<string, number>,
    projectedEnd: Record<string, number>,
    startApply: Record<string, number>,
    endApply: Record<string, number>,
): NonceTrace {
    const trace: NonceTrace = {}
    for (const account of accounts) {
        trace[account] = {
            startFilter: startFilter[account] ?? 0,
            projectedEnd: projectedEnd[account] ?? 0,
            startApply: startApply[account] ?? 0,
            endApply: endApply[account] ?? 0,
        }
    }
    return trace
}

export function readNonceTrace(
    attrs: Record<string, any> | null | undefined,
): NonceTrace | null {
    const trace = attrs?.[NONCE_TRACE_ATTR_KEY]
    if (!trace || typeof trace !== "object") return null
    return trace as NonceTrace
}

interface Mismatch {
    account: string
    field: string
    expected: number
    actual: number
}

function crash(context: string, blockNumber: number, mismatches: Mismatch[]) {
    log.error(
        `[DEBUG_ASSERT] ${context}: nonce trace mismatch on block ${blockNumber} for ${mismatches.length} account(s)`,
    )
    for (const mismatch of mismatches) {
        log.error(
            `[DEBUG_ASSERT] ${mismatch.account} ${mismatch.field}: expected ${mismatch.expected}, got ${mismatch.actual}`,
        )
    }
    log.error(
        "[DEBUG_ASSERT] Mismatches: " + JSON.stringify(mismatches, null, 2),
    )
    // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
    process.exit(1)
}

/**
 * Forger-side self check: the pre-apply state must match what the nonce filter
 * observed, and the post-apply state must match the deltas of the txs that were
 * actually applied.
 */
export function assertForgedNonceTrace(
    blockNumber: number,
    trace: NonceTrace,
    appliedTxs: Transaction[],
) {
    const deltas = sumNonceDeltas(appliedTxs)
    const mismatches: Mismatch[] = []
    const drifted: string[] = []

    for (const [account, entry] of Object.entries(trace)) {
        if (entry.startApply !== entry.startFilter) {
            mismatches.push({
                account,
                field: "startApply",
                expected: entry.startFilter,
                actual: entry.startApply,
            })
        }

        const expectedEnd = entry.startApply + (deltas[account] ?? 0)
        if (entry.endApply !== expectedEnd) {
            mismatches.push({
                account,
                field: "endApply",
                expected: expectedEnd,
                actual: entry.endApply,
            })
        }

        if (entry.endApply < entry.startApply) {
            mismatches.push({
                account,
                field: "delta",
                expected: 0,
                actual: entry.endApply - entry.startApply,
            })
        }

        if (entry.projectedEnd !== entry.endApply) {
            drifted.push(
                `${account}: projected ${entry.projectedEnd}, applied ${entry.endApply}`,
            )
        }
    }

    if (drifted.length > 0) {
        log.warn(
            `[DEBUG_ASSERT] Block ${blockNumber}: ${drifted.length} account(s) diverged from the filter-time projection (expected when txs are dropped after filtering)`,
        )
        log.warn("[DEBUG_ASSERT] " + JSON.stringify(drifted, null, 2))
    }

    if (mismatches.length > 0) {
        crash("consensus", blockNumber, mismatches)
    }
}

/**
 * Sync-side check: our local nonces before and after applying the block must
 * match the values the forger recorded.
 */
export function assertSyncedNonceTrace(
    blockNumber: number,
    trace: NonceTrace,
    localBefore: Record<string, number>,
    localAfter: Record<string, number>,
) {
    const mismatches: Mismatch[] = []

    for (const [account, entry] of Object.entries(trace)) {
        const before = localBefore[account] ?? 0
        const after = localAfter[account] ?? 0

        if (before !== entry.startApply) {
            mismatches.push({
                account,
                field: "startApply",
                expected: entry.startApply,
                actual: before,
            })
        }

        if (after !== entry.endApply) {
            mismatches.push({
                account,
                field: "endApply",
                expected: entry.endApply,
                actual: after,
            })
        }
    }

    if (mismatches.length > 0) {
        crash("sync", blockNumber, mismatches)
    }
}
