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
    count: number
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
 * The count is cached for a few seconds and bumped locally on each admission,
 * so the check costs one query per subnet per interval rather than one per
 * message, and a burst cannot overshoot the cap by more than what the cache
 * has not yet seen from other writers.
 */
export class ExecutedBacklogGuard {
    private readonly subnets = new Map<string, SubnetState>()
    private readonly now: () => number
    private readonly ttlMs: number

    constructor(private readonly opts: BacklogGuardOptions) {
        this.now = opts.now ?? Date.now
        this.ttlMs = opts.ttlMs ?? COUNT_TTL_MS
    }

    async admit(l2psUid: string): Promise<Admission> {
        const { cap } = this.opts
        if (cap <= 0) return { admitted: true, count: 0, cap, retryAfterMs: this.opts.retryAfterMs }

        const state = await this.current(l2psUid)
        this.warnAtHalf(l2psUid, state)

        if (state.count >= cap) {
            this.reportFull(l2psUid, state)
            return { admitted: false, count: state.count, cap, retryAfterMs: this.opts.retryAfterMs }
        }
        state.count++
        return { admitted: true, count: state.count, cap, retryAfterMs: this.opts.retryAfterMs }
    }

    private async current(l2psUid: string): Promise<SubnetState> {
        let state = this.subnets.get(l2psUid)
        if (!state) {
            state = { count: 0, fetchedAt: Number.NEGATIVE_INFINITY, halfWarned: false, lastCapLog: Number.NEGATIVE_INFINITY, refresh: null }
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
            state.count = await this.opts.countExecuted(l2psUid)
        } catch (error) {
            // A failed count must not stop a subnet from working; the next
            // interval asks again.
            log.warning(`[L2PS Backlog] Could not count executed rows for ${l2psUid}: ${error}`)
        }
        state.fetchedAt = this.now()
    }

    private warnAtHalf(l2psUid: string, state: SubnetState): void {
        const half = this.opts.cap / 2
        if (state.count < half) {
            state.halfWarned = false
        } else if (!state.halfWarned) {
            state.halfWarned = true
            log.warning(`[L2PS Backlog] ${l2psUid} has ${state.count} executed transactions waiting, half of the ${this.opts.cap} cap`)
        }
    }

    private reportFull(l2psUid: string, state: SubnetState): void {
        const now = this.now()
        if (now - state.lastCapLog < CAP_LOG_INTERVAL_MS) return
        state.lastCapLog = now
        log.error(`[L2PS Backlog] ${l2psUid} is at the cap of ${this.opts.cap} executed transactions; refusing new ones until the aggregator catches up`)
    }
}

let shared: ExecutedBacklogGuard | null = null

/** The node's guard, built on first use from the configuration. */
export function getExecutedBacklogGuard(): ExecutedBacklogGuard {
    shared ??= new ExecutedBacklogGuard({
        cap: Config.getInstance().l2ps.mempoolMaxExecutedPerSubnet,
        retryAfterMs: Config.getInstance().l2ps.aggregationIntervalMs,
        countExecuted: async uid =>
            (await L2PSMempool.getSummaryByUIDAndStatus(uid, "executed")).count,
    })
    return shared
}
