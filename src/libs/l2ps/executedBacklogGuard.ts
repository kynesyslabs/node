import { Config } from "src/config"
import log from "@/utilities/logger"
import L2PSMempool from "@/libs/blockchain/l2ps_mempool"

/** Error code a refused submission carries, on every transport. */
export const L2PS_BACKLOG_FULL = "L2PS_BACKLOG_FULL"

/** How long a subnet's backlog count is trusted before it is read again. */
const COUNT_TTL_MS = 3000
/** Minimum gap between two error logs for the same subnet at the cap. */
const CAP_LOG_INTERVAL_MS = 60_000

/** Outcome of an admission check; count and cap describe the subnet at that moment. */
export interface Admission {
    admitted: boolean
    count: number
    cap: number
    retryAfterMs: number
}

interface SubnetState {
    /** Rows with status executed, as last read from the database. */
    dbCount: number
    /** Slots claimed here whose row is not yet counted by the database: still running, or finished some other way. */
    pending: number
    /** False until a count has been read once; a failed read before that has nothing to fall back on. */
    known: boolean
    fetchedAt: number
    halfWarned: boolean
    lastCapLog: number
    refresh: Promise<void> | null
}

export interface BacklogGuardOptions {
    cap: number
    retryAfterMs: number
    countExecuted: (l2psUid: string) => Promise<number>
    now?: () => number
    ttlMs?: number
}

/**
 * Stops a subnet's executed backlog growing past a cap. The aggregator drains a
 * few batches per cycle, so ingest above that rate would otherwise queue
 * without end, and the backlog is read in full by each hash cycle.
 *
 * The database count is cached for a few seconds and the claims taken here
 * are kept beside it, so the check costs one query per subnet per interval
 * rather than one per message, a refresh does not forget a claim still in
 * flight, and a burst cannot overshoot the cap by more than what the cache
 * has not yet seen from other writers. A claim is given back with `release`
 * once its row is executed (the database counts it from then on) or the
 * attempt failed.
 */
export class ExecutedBacklogGuard {
    private readonly subnets = new Map<string, SubnetState>()
    private readonly now: () => number
    private readonly ttlMs: number

    constructor(private readonly opts: BacklogGuardOptions) {
        this.now = opts.now ?? Date.now
        this.ttlMs = opts.ttlMs ?? COUNT_TTL_MS
    }

    /**
     * Whether the subnet has room, without taking any. For a cheap refusal
     * before work that may still fail; `claim` takes the slot once it will not.
     */
    async check(l2psUid: string): Promise<Admission> {
        const { cap } = this.opts
        if (cap <= 0) return { admitted: true, count: 0, cap, retryAfterMs: this.opts.retryAfterMs }

        const state = await this.current(l2psUid)
        this.warnAtHalf(l2psUid, state)

        const count = this.total(state)
        if (count >= cap) {
            this.reportFull(l2psUid, state)
            return { admitted: false, count, cap, retryAfterMs: this.opts.retryAfterMs }
        }
        return { admitted: true, count, cap, retryAfterMs: this.opts.retryAfterMs }
    }

    /**
     * Take a slot for a transaction that is about to be queued. Synchronous, so
     * a burst cannot pass the cap between the check and the claim. False when
     * the subnet filled up in the meantime.
     */
    claim(l2psUid: string): boolean {
        if (this.opts.cap <= 0) return true
        const state = this.subnets.get(l2psUid)
        if (!state) return true
        if (this.total(state) >= this.opts.cap) return false
        state.pending++
        return true
    }

    /**
     * Give back a slot taken by `claim` for an attempt that failed: the row
     * will never be executed, so nothing holds the room.
     */
    release(l2psUid: string): void {
        const state = this.subnets.get(l2psUid)
        if (state && state.pending > 0) state.pending--
    }

    /**
     * Move a slot taken by `claim` into the executed count. The row is
     * executed now, but the cached database count predates it by up to one
     * refresh interval; counting it here until the next refresh keeps a burst
     * from passing the cap through the gap.
     */
    settle(l2psUid: string): void {
        const state = this.subnets.get(l2psUid)
        if (!state) return
        if (state.pending > 0) state.pending--
        state.dbCount++
    }

    /** Check and claim in one step, for a caller with nothing left that could fail. */
    async admit(l2psUid: string): Promise<Admission> {
        const outcome = await this.check(l2psUid)
        if (!outcome.admitted) return outcome
        if (!this.claim(l2psUid)) return { ...outcome, admitted: false }
        return { ...outcome, count: outcome.count + 1 }
    }

    get retryAfterMs(): number {
        return this.opts.retryAfterMs
    }

    private async current(l2psUid: string): Promise<SubnetState> {
        let state = this.subnets.get(l2psUid)
        if (!state) {
            state = { dbCount: 0, pending: 0, known: false, fetchedAt: Number.NEGATIVE_INFINITY, halfWarned: false, lastCapLog: Number.NEGATIVE_INFINITY, refresh: null }
            this.subnets.set(l2psUid, state)
        }
        if (this.now() - state.fetchedAt >= this.ttlMs) {
            state.refresh ??= this.reload(l2psUid, state).finally(() => {
                state.refresh = null
            })
            await state.refresh
        }
        return state
    }

    private async reload(l2psUid: string, state: SubnetState): Promise<void> {
        try {
            state.dbCount = await this.opts.countExecuted(l2psUid)
            state.known = true
        } catch (error) {
            // A failed count keeps the last one read, so a database hiccup does
            // not reopen a subnet that was at its cap. With no count yet there
            // is nothing to hold on to and messages pass; the next interval
            // asks again either way.
            log.warning(`[L2PS Backlog] Could not count executed rows for ${l2psUid}${state.known ? ", keeping the last count" : ""}: ${error}`)
        }
        state.fetchedAt = this.now()
    }

    private total(state: SubnetState): number {
        return state.dbCount + state.pending
    }

    private warnAtHalf(l2psUid: string, state: SubnetState): void {
        const half = this.opts.cap / 2
        const count = this.total(state)
        if (count < half) {
            state.halfWarned = false
        } else if (!state.halfWarned) {
            state.halfWarned = true
            log.warning(`[L2PS Backlog] ${l2psUid} has ${count} executed transactions waiting, half of the ${this.opts.cap} cap`)
        }
    }

    private reportFull(l2psUid: string, state: SubnetState): void {
        const now = this.now()
        if (now - state.lastCapLog < CAP_LOG_INTERVAL_MS) return
        state.lastCapLog = now
        log.error(`[L2PS Backlog] ${l2psUid} is at the cap of ${this.opts.cap} executed transactions; refusing new ones until the aggregator catches up`)
    }
}

/** What an unauthenticated caller is told: the code and when to retry, not how full the queue is. */
export function backlogFullMessage(retryAfterMs: number): string {
    return `${L2PS_BACKLOG_FULL}: retryAfterMs=${retryAfterMs}`
}

let shared: ExecutedBacklogGuard | null = null

/** The node's guard, built on first use from the configuration. */
export function getExecutedBacklogGuard(): ExecutedBacklogGuard {
    shared ??= new ExecutedBacklogGuard({
        cap: Config.getInstance().l2ps.mempoolMaxExecutedPerSubnet,
        retryAfterMs: Config.getInstance().l2ps.aggregationIntervalMs,
        countExecuted: uid => L2PSMempool.countByUIDAndStatus(uid, "executed"),
    })
    return shared
}
