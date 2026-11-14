import { Config } from "src/config"
import { WEB2_REQUEST_TIMEOUT_MS } from "src/libs/abstraction/web2/boundedFetch"
import log from "src/utilities/logger"

/**
 * Admission control for the outbound fetches the node makes on a caller's
 * behalf through the web2 (DAHR) proxy. The proxy needs no signature and no
 * fee, and each fetch may read up to web2MaxResponseBytes for up to 30 s, so
 * without these caps one source could keep a validator busy downloading for
 * it all day.
 *
 * Operator-local only: nothing here feeds block validity or state.
 */

export interface Web2FetchLimits {
    /** Fetches one caller may have running at once. */
    maxInflightPerCaller: number
    /** Fetches one caller may start per minute (token bucket, burst = limit). */
    maxFetchesPerMinutePerCaller: number
    /** Response bytes one caller may pull per hour (token bucket, burst = limit). */
    maxBytesPerHourPerCaller: number
    /** Fetches running at once across every caller and every path. */
    maxInflightTotal: number
}

export interface Web2FetchLimiterOptions extends Web2FetchLimits {
    /** Callers tracked at once; the least recently seen idle one makes room. */
    maxTrackedCallers?: number
    /** A slot still held after this long is freed, so a hung fetch cannot pin it. */
    holdLimitMs?: number
    /** How often fully refilled callers are dropped from the table. */
    sweepIntervalMs?: number
    /** Shortest gap between two refusal log lines. */
    refusalLogIntervalMs?: number
    now?: () => number
}

/**
 * Who a fetch is counted against. `key` is namespaced by its source ("ip:" or
 * "addr:"). An exempt caller skips the per-caller limits but still takes a
 * node-wide slot.
 */
export interface Web2FetchCaller {
    key: string
    exempt?: boolean
}

export type Web2FetchRefusalReason =
    | "caller-inflight"
    | "caller-rate"
    | "caller-bytes"
    | "node-inflight"

export interface Web2FetchRefusal {
    reason: Web2FetchRefusalReason
    retryAfterSeconds: number
    message: string
}

export interface Web2FetchLease {
    /**
     * Frees the slot and charges the bytes actually read from the origin.
     * Safe to call more than once; only the first call counts.
     */
    release(bytesReceived?: number): void
}

export interface Web2FetchAdmission {
    lease: Web2FetchLease | null
    refusal: Web2FetchRefusal | null
}

export const WEB2_FETCH_LIMITED = "WEB2_FETCH_LIMITED"

const DEFAULT_MAX_TRACKED_CALLERS = 10_000
// Above the proxy's own deadline plus relay setup and teardown, so only a
// fetch that ignored its deadline ever reaches it.
const DEFAULT_HOLD_LIMIT_MS = 2 * WEB2_REQUEST_TIMEOUT_MS
const DEFAULT_SWEEP_INTERVAL_MS = 60_000
const DEFAULT_REFUSAL_LOG_INTERVAL_MS = 10_000
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

interface CallerState {
    tokens: number
    bytes: number
    inflight: number
    updatedAt: number
}

export function web2CallerForAddress(address: unknown): Web2FetchCaller {
    const normalized =
        typeof address === "string" && address.trim() !== ""
            ? address.trim().toLowerCase().replace(/^0x/, "")
            : "unknown"
    return { key: `addr:${normalized}` }
}

export class Web2FetchLimiter {
    private static _instance: Web2FetchLimiter | null = null

    private readonly limits: Web2FetchLimits
    private readonly maxTrackedCallers: number
    private readonly holdLimitMs: number
    private readonly sweepIntervalMs: number
    private readonly refusalLogIntervalMs: number
    private readonly now: () => number
    private readonly tokensPerMs: number
    private readonly bytesPerMs: number

    // Insertion order doubles as recency: a caller is re-inserted on each use.
    private readonly callers = new Map<string, CallerState>()
    private inflightTotal = 0
    private lastSweepAt: number
    private lastRefusalLogAt = Number.NEGATIVE_INFINITY
    private refusalsSinceLog = new Map<Web2FetchRefusalReason, number>()
    private evictions = 0

    constructor(options: Web2FetchLimiterOptions) {
        this.limits = {
            maxInflightPerCaller: options.maxInflightPerCaller,
            maxFetchesPerMinutePerCaller: options.maxFetchesPerMinutePerCaller,
            maxBytesPerHourPerCaller: options.maxBytesPerHourPerCaller,
            maxInflightTotal: options.maxInflightTotal,
        }
        for (const [name, value] of Object.entries(this.limits)) {
            if (!Number.isInteger(value) || value <= 0) {
                throw new Error(
                    `Web2FetchLimiter: ${name} must be an integer > 0 (got ${value})`,
                )
            }
        }
        this.maxTrackedCallers =
            options.maxTrackedCallers ?? DEFAULT_MAX_TRACKED_CALLERS
        this.holdLimitMs = options.holdLimitMs ?? DEFAULT_HOLD_LIMIT_MS
        this.sweepIntervalMs =
            options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
        this.refusalLogIntervalMs =
            options.refusalLogIntervalMs ?? DEFAULT_REFUSAL_LOG_INTERVAL_MS
        this.now = options.now ?? Date.now
        this.tokensPerMs = this.limits.maxFetchesPerMinutePerCaller / MINUTE_MS
        this.bytesPerMs = this.limits.maxBytesPerHourPerCaller / HOUR_MS
        this.lastSweepAt = this.now()
    }

    /** The node's limiter, built from the outbound config on first use. */
    static get instance(): Web2FetchLimiter {
        if (!Web2FetchLimiter._instance) {
            const o = Config.getInstance().outbound
            Web2FetchLimiter._instance = new Web2FetchLimiter({
                maxInflightPerCaller: o.web2MaxInflightPerCaller,
                maxFetchesPerMinutePerCaller: o.web2MaxFetchesPerMinutePerCaller,
                maxBytesPerHourPerCaller: o.web2MaxBytesPerHourPerCaller,
                maxInflightTotal: o.web2MaxInflightTotal,
            })
        }
        return Web2FetchLimiter._instance
    }

    static resetInstance(): void {
        Web2FetchLimiter._instance = null
    }

    /**
     * Admits one fetch or says why not. Nothing is consumed on a refusal, so a
     * refused caller is not pushed further back by retrying.
     */
    acquire(caller?: Web2FetchCaller): Web2FetchAdmission {
        const now = this.now()
        this.maybeSweep(now)

        const perCaller = caller && !caller.exempt
        let state: CallerState | null = null
        if (perCaller) {
            state = this.touch(caller.key, now)
            const refusal = this.checkCaller(state)
            if (refusal) return this.refuse(refusal, now)
        }
        if (this.inflightTotal >= this.limits.maxInflightTotal) {
            return this.refuse(
                {
                    reason: "node-inflight",
                    retryAfterSeconds: 1,
                    message:
                        "web2 fetch refused: this node is running its maximum " +
                        `of ${this.limits.maxInflightTotal} web2 fetches. ` +
                        "Retry after 1 s.",
                },
                now,
            )
        }

        if (state) {
            state.tokens -= 1
            state.inflight += 1
        }
        this.inflightTotal += 1
        return { lease: this.makeLease(state), refusal: null }
    }

    stats(): { trackedCallers: number; inflightTotal: number; evictions: number } {
        return {
            trackedCallers: this.callers.size,
            inflightTotal: this.inflightTotal,
            evictions: this.evictions,
        }
    }

    private makeLease(state: CallerState | null): Web2FetchLease {
        let slotHeld = true
        let settled = false
        const freeSlot = () => {
            if (!slotHeld) return
            slotHeld = false
            this.inflightTotal -= 1
            if (state) state.inflight -= 1
        }
        const watchdog = setTimeout(() => {
            if (!slotHeld) return
            freeSlot()
            log.warning(
                `[web2] A web2 fetch held its slot past ${this.holdLimitMs} ms; slot freed`,
            )
        }, this.holdLimitMs)
        ;(watchdog as { unref?: () => void }).unref?.()

        return {
            release: (bytesReceived = 0) => {
                if (settled) return
                settled = true
                clearTimeout(watchdog)
                freeSlot()
                if (state && bytesReceived > 0) {
                    this.refill(state, this.now())
                    state.bytes -= bytesReceived
                }
            },
        }
    }

    private checkCaller(state: CallerState): Web2FetchRefusal | null {
        const l = this.limits
        if (state.inflight >= l.maxInflightPerCaller) {
            return {
                reason: "caller-inflight",
                retryAfterSeconds: 1,
                message:
                    `web2 fetch refused: this caller already has ${l.maxInflightPerCaller} ` +
                    "web2 fetches in flight. Retry after 1 s.",
            }
        }
        if (state.tokens < 1) {
            const wait = this.seconds((1 - state.tokens) / this.tokensPerMs)
            return {
                reason: "caller-rate",
                retryAfterSeconds: wait,
                message:
                    `web2 fetch refused: this caller may start ${l.maxFetchesPerMinutePerCaller} ` +
                    `web2 fetches per minute. Retry after ${wait} s.`,
            }
        }
        if (state.bytes <= 0) {
            const wait = this.seconds((1 - state.bytes) / this.bytesPerMs)
            return {
                reason: "caller-bytes",
                retryAfterSeconds: wait,
                message:
                    `web2 fetch refused: this caller used its budget of ${l.maxBytesPerHourPerCaller} ` +
                    `response bytes per hour. Retry after ${wait} s.`,
            }
        }
        return null
    }

    /** The caller's state, refilled to `now` and marked most recently used. */
    private touch(key: string, now: number): CallerState {
        let state = this.callers.get(key)
        if (state) {
            this.callers.delete(key)
            this.refill(state, now)
        } else {
            this.makeRoom()
            state = {
                tokens: this.limits.maxFetchesPerMinutePerCaller,
                bytes: this.limits.maxBytesPerHourPerCaller,
                inflight: 0,
                updatedAt: now,
            }
        }
        this.callers.set(key, state)
        return state
    }

    private refill(state: CallerState, now: number): void {
        const elapsed = Math.max(0, now - state.updatedAt)
        state.tokens = Math.min(
            this.limits.maxFetchesPerMinutePerCaller,
            state.tokens + elapsed * this.tokensPerMs,
        )
        state.bytes = Math.min(
            this.limits.maxBytesPerHourPerCaller,
            state.bytes + elapsed * this.bytesPerMs,
        )
        state.updatedAt = now
    }

    /**
     * Drops the least recently used caller with nothing in flight. A caller
     * with a fetch running keeps its entry: its lease still points at it.
     * In-flight callers never exceed the node-wide cap, so with the table
     * larger than that cap there is always one to drop.
     */
    private makeRoom(): void {
        if (this.callers.size < this.maxTrackedCallers) return
        for (const [key, state] of this.callers) {
            if (state.inflight === 0) {
                this.callers.delete(key)
                this.evictions += 1
                return
            }
        }
    }

    /** A fully refilled idle caller is the same as an unknown one. */
    private maybeSweep(now: number): void {
        if (now - this.lastSweepAt < this.sweepIntervalMs) return
        this.lastSweepAt = now
        for (const [key, state] of this.callers) {
            if (state.inflight > 0) continue
            this.refill(state, now)
            if (
                state.tokens >= this.limits.maxFetchesPerMinutePerCaller &&
                state.bytes >= this.limits.maxBytesPerHourPerCaller
            ) {
                this.callers.delete(key)
            }
        }
    }

    private refuse(refusal: Web2FetchRefusal, now: number): Web2FetchAdmission {
        this.refusalsSinceLog.set(
            refusal.reason,
            (this.refusalsSinceLog.get(refusal.reason) ?? 0) + 1,
        )
        // One summary line per interval, however hard the node is pushed.
        if (now - this.lastRefusalLogAt >= this.refusalLogIntervalMs) {
            const counts = [...this.refusalsSinceLog]
                .map(([reason, n]) => `${reason}=${n}`)
                .join(", ")
            log.warning(`[web2] Refused web2 fetches: ${counts}`)
            this.refusalsSinceLog.clear()
            this.lastRefusalLogAt = now
        }
        return { lease: null, refusal }
    }

    private seconds(ms: number): number {
        return Math.max(1, Math.ceil(ms / 1000))
    }
}
