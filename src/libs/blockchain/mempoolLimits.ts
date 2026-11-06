import type { Transaction } from "@kynesyslabs/demosdk/types"
import { getMetricsService } from "src/features/metrics/MetricsService"
import {
    MEMPOOL_MAX_BYTES,
    MEMPOOL_MAX_FUTURE_SKEW_MS,
    MEMPOOL_MAX_PENDING_PER_SENDER,
    MEMPOOL_MAX_TXS,
    MEMPOOL_TX_TTL_MS,
    MERGE_PAYLOAD_MAX_BYTES,
} from "src/utilities/constants"

export interface MempoolLimits {
    maxTxs: number
    maxBytes: number
    maxPerSender: number
    ttlMs: number
    maxFutureSkewMs: number
    /** Most bytes of txs, as sent, in one merge request or reply. */
    mergeMaxBytes: number
}

const DEFAULT_LIMITS: MempoolLimits = {
    maxTxs: MEMPOOL_MAX_TXS,
    maxBytes: MEMPOOL_MAX_BYTES,
    maxPerSender: MEMPOOL_MAX_PENDING_PER_SENDER,
    ttlMs: MEMPOOL_TX_TTL_MS,
    maxFutureSkewMs: MEMPOOL_MAX_FUTURE_SKEW_MS,
    mergeMaxBytes: MERGE_PAYLOAD_MAX_BYTES,
}

let active: MempoolLimits = { ...DEFAULT_LIMITS }

export function getMempoolLimits(): MempoolLimits {
    return active
}

/** Tests only: production runs on the constants. */
// eslint-disable-next-line @typescript-eslint/naming-convention
export function __setMempoolLimits(overrides: Partial<MempoolLimits>): void {
    active = { ...DEFAULT_LIMITS, ...overrides }
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetMempoolLimits(): void {
    active = { ...DEFAULT_LIMITS }
}

export type MempoolRejectReason =
    | "expired"
    | "future_dated"
    | "bad_timestamp"
    | "sender_limit"
    | "pool_full"
    | "bytes_full"
    | "unfunded"

const REJECT_MESSAGES: Record<MempoolRejectReason, (l: MempoolLimits) => string> = {
    expired: l =>
        `Transaction expired: signed more than ${Math.round(l.ttlMs / 1000)}s ago`,
    future_dated: () => "Transaction timestamp is ahead of the node clock",
    bad_timestamp: () =>
        "Transaction timestamp must be a positive whole number of milliseconds",
    sender_limit: l =>
        `Too many pending transactions from this sender (limit ${l.maxPerSender})`,
    pool_full: l =>
        `Mempool full (${l.maxTxs} transactions); retry later or raise the fee`,
    bytes_full: l =>
        `Mempool full (${Math.round(l.maxBytes / (1024 * 1024))} MiB of transactions); retry later or raise the fee`,
    unfunded: () =>
        "Mempool full and the sender balance does not cover the transaction fee",
}

export function rejectMessage(reason: MempoolRejectReason): string {
    return REJECT_MESSAGES[reason](active)
}

/** Counts a rejection so operators can see a pool under pressure. */
export function countMempoolRejection(reason: MempoolRejectReason | "evicted"): void {
    try {
        const m = getMetricsService()
        m.createCounter(
            "mempool_rejected_total",
            "Transactions the mempool refused or evicted, by reason",
            ["reason"],
        )
        m.incrementCounter("mempool_rejected_total", { reason })
    } catch {
        // metrics must never break admission
    }
}

function jsonBytes(value: unknown): number {
    return value === undefined || value === null
        ? 0
        : Buffer.byteLength(JSON.stringify(value))
}

/**
 * Size of a tx as the mempool table stores it: the same columns, measured
 * the same way, as the SQL that totals the pool, so the incoming tx and the
 * rows already held are counted by one rule.
 */
export function txStoredBytes(
    tx: Pick<Transaction, "hash" | "content" | "signature"> & {
        ed25519_signature?: unknown
        extra?: unknown
    },
): number {
    return (
        jsonBytes(tx.content) +
        jsonBytes(tx.signature) +
        jsonBytes(tx.extra) +
        (typeof tx.ed25519_signature === "string"
            ? Buffer.byteLength(tx.ed25519_signature)
            : 0) +
        Buffer.byteLength(tx.hash ?? "")
    )
}

const OS_PER_DEM = 1_000_000_000n

// Fee fields arrive either as a DEM number (before the tx is serialised) or as
// an OS string/bigint (after), the same convention the fee check at submit
// uses. Everything is ranked and compared in OS so rows in either form order
// correctly, and a negative component counts for nothing: it would let a tx
// rank itself below the cheapest honest one.
function toOsBigInt(value: unknown): bigint {
    try {
        if (typeof value === "bigint") return value > 0n ? value : 0n
        if (typeof value === "number" && Number.isFinite(value)) {
            return value > 0 ? BigInt(Math.round(value)) * OS_PER_DEM : 0n
        }
        if (typeof value === "string" && /^\d+$/.test(value)) {
            return BigInt(value)
        }
    } catch {
        // fall through
    }
    return 0n
}

/** Total fee a tx offers, in OS, from its signed fee fields. */
export function txTotalFee(
    fee:
        | {
              network_fee?: unknown
              rpc_fee?: unknown
              additional_fee?: unknown
          }
        | null
        | undefined,
): bigint {
    if (!fee) return 0n
    return (
        toOsBigInt(fee.network_fee) +
        toOsBigInt(fee.rpc_fee) +
        toOsBigInt(fee.additional_fee)
    )
}

/** 15 digits: far beyond any real clock, and what the SQL sweep can match. */
const MAX_SIGNED_TIMESTAMP = 999_999_999_999_999

/**
 * The signed timestamp when it is a positive whole number of milliseconds,
 * else null. The one definition both the admission check and the SQL sweep
 * use, so a tx cannot pass one and be judged differently by the other.
 */
export function signedTimestampMs(tx: Pick<Transaction, "content">): number | null {
    const ts = tx.content?.timestamp as unknown
    return typeof ts === "number" &&
        Number.isInteger(ts) &&
        ts > 0 &&
        ts <= MAX_SIGNED_TIMESTAMP
        ? ts
        : null
}

/** Whether the tx's signed timestamp is inside its lifetime. */
export function checkTxAge(
    tx: Pick<Transaction, "content">,
    now: number,
    limits: MempoolLimits = active,
): "expired" | "future_dated" | "bad_timestamp" | null {
    const ts = signedTimestampMs(tx)
    if (ts === null) return "bad_timestamp"
    if (now - ts > limits.ttlMs) return "expired"
    if (ts - now > limits.maxFutureSkewMs) return "future_dated"
    return null
}

/** What the pool holds, as far as caps are concerned. */
export interface PoolUsage {
    count: number
    bytes: number
}

export interface EvictionCandidate {
    hash: string
    fee: bigint
    timestamp: number
    bytes: number
}

/**
 * Picks the txs to drop so an incoming one fits: lowest fee first, and among
 * equal fees the oldest. A candidate is only dropped for a tx that pays
 * strictly more, so a flood at the going fee cannot push out txs already
 * waiting; it is turned away instead. Returns null when no such set frees
 * enough room, in which case nothing should be evicted.
 */
export function chooseVictims(
    candidates: readonly EvictionCandidate[],
    incoming: { fee: bigint; bytes: number },
    usage: PoolUsage,
    limits: MempoolLimits = active,
): EvictionCandidate[] | null {
    let count = usage.count
    let bytes = usage.bytes
    const over = () =>
        count + 1 > limits.maxTxs || bytes + incoming.bytes > limits.maxBytes

    const ordered = [...candidates].sort((a, b) =>
        a.fee === b.fee
            ? a.timestamp - b.timestamp
            : a.fee < b.fee
              ? -1
              : 1,
    )
    const victims: EvictionCandidate[] = []
    for (const candidate of ordered) {
        if (!over()) break
        if (candidate.fee >= incoming.fee) return null
        victims.push(candidate)
        count -= 1
        bytes -= candidate.bytes
    }
    return over() ? null : victims
}

/** Size of a tx as a merge request or reply carries it. */
export function txWireBytes(tx: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(tx) ?? "")
    } catch {
        // Cannot be sent at all; sized so it travels alone.
        return Number.MAX_SAFE_INTEGER
    }
}

/**
 * Splits a pool into the requests that carry it to a peer, in the pool's
 * order. A request holds at most the pool's tx count, which the receiving
 * side enforces, and at most `mergeMaxBytes` as sent, so it fits one Omni
 * frame. A pool within the admission caps is one request; the pool can be
 * larger, because the node's own relay tx and the txs merged in from
 * committee members are exempt from them. A tx larger than a request ships
 * alone. Always returns at least one batch, because an empty exchange still
 * brings the peer's pool back.
 */
export function splitMergeBatches<T>(
    txs: readonly T[],
    limits: MempoolLimits = active,
): T[][] {
    const batches: T[][] = []
    let current: T[] = []
    let currentBytes = 0
    for (const tx of txs) {
        const bytes = txWireBytes(tx)
        if (
            current.length > 0 &&
            (current.length + 1 > limits.maxTxs ||
                currentBytes + bytes > limits.mergeMaxBytes)
        ) {
            batches.push(current)
            current = []
            currentBytes = 0
        }
        current.push(tx)
        currentBytes += bytes
    }
    if (current.length > 0 || batches.length === 0) batches.push(current)
    return batches
}

/**
 * The part of `txs` one merge reply carries: the leading txs that fit one
 * request, in the order given. The rest reach the caller through this node's
 * own requests to it, which carry the whole pool.
 */
export function capMergeReply<T>(
    txs: readonly T[],
    limits: MempoolLimits = active,
): T[] {
    return splitMergeBatches(txs, limits)[0]
}

/** One pending tx as the per-sender cap of the merge sees it. */
export interface SenderSlot {
    hash: string
    /** Lowercase `content.from`. */
    sender: string
    nonce: unknown
}

function slotNonce(value: unknown): bigint | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return BigInt(value)
    }
    if (typeof value === "string" && /^\d{1,20}$/.test(value)) {
        return BigInt(value)
    }
    return null
}

function compareSlots(a: SenderSlot, b: SenderSlot): number {
    const na = slotNonce(a.nonce)
    const nb = slotNonce(b.nonce)
    if (na !== nb) {
        if (na === null) return 1
        if (nb === null) return -1
        return na < nb ? -1 : 1
    }
    return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0
}

/**
 * Holds every sender with merged-in txs to `maxPerSender` pending txs,
 * keeping the lowest nonces (then the lowest hashes) of what is held and
 * what arrives. The choice depends only on the set of txs, not on which
 * arrived first, so members that end the merge having seen the same txs
 * keep the same ones. Returns the incoming hashes to refuse and the held
 * hashes to evict.
 */
export function chooseSenderOverflow(
    held: readonly SenderSlot[],
    incoming: readonly SenderSlot[],
    maxPerSender: number = active.maxPerSender,
): { refuse: Set<string>; evict: string[] } {
    const bySender = new Map<string, { slot: SenderSlot; held: boolean }[]>()
    for (const slot of incoming) {
        const list = bySender.get(slot.sender) ?? []
        list.push({ slot, held: false })
        bySender.set(slot.sender, list)
    }
    for (const slot of held) {
        bySender.get(slot.sender)?.push({ slot, held: true })
    }

    const refuse = new Set<string>()
    const evict: string[] = []
    for (const list of bySender.values()) {
        if (list.length <= maxPerSender) continue
        list.sort((a, b) => compareSlots(a.slot, b.slot))
        for (const { slot, held: isHeld } of list.slice(maxPerSender)) {
            if (isHeld) evict.push(slot.hash)
            else refuse.add(slot.hash)
        }
    }
    return { refuse, evict }
}
