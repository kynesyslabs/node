/**
 * Pure liveness judgement for the gossip sidecar, evaluated once per heights
 * tick on the Bun side. Every verdict that leads to a restart is positive
 * evidence that the sidecar is at fault; quiet is never a fault on its own,
 * because a node that is alone or partitioned must keep running.
 */

export const STATS_STALE_MS = 5_000
/** Stale stats are judged even on a late tick once they are this old. */
export const STATS_STALE_HARD_CAP_MS = 15_000
export const TICK_LATE_TOLERANCE_MS = 2_000
/** Every staked node publishes heights each second; this long with nothing inbound is silence. */
export const INBOUND_SILENCE_MS = 10_000

export type SidecarHealthVerdict =
    | { kind: "ok" }
    | { kind: "deferred"; reason: "late_tick" }
    | { kind: "fault"; reason: "stats_stalled" | "stats_stalled_hard" }
    | { kind: "silent" }

export interface SidecarHealthInputs {
    now: number
    /** Milliseconds this tick fired after its scheduled time. */
    tickLateMs: number
    lastStatsAt: number
    lastInboundAt: number
    /** Subscribers on the heights topic from the latest stats. */
    heightsSubscribers: number
    /** True when the child process has already exited (the exit handler owns that case). */
    processExited: boolean
}

export function judgeSidecarHealth(
    input: SidecarHealthInputs,
): SidecarHealthVerdict {
    if (input.processExited) return { kind: "ok" }

    const staleMs = input.now - input.lastStatsAt
    if (staleMs > STATS_STALE_HARD_CAP_MS) {
        return { kind: "fault", reason: "stats_stalled_hard" }
    }
    if (staleMs > STATS_STALE_MS) {
        if (input.tickLateMs > TICK_LATE_TOLERANCE_MS) {
            return { kind: "deferred", reason: "late_tick" }
        }
        return { kind: "fault", reason: "stats_stalled" }
    }

    // Heartbeat is fresh: the sidecar's event loop runs. Now the transport.
    // Silence with subscribers present needs the HTTP cross-check before it
    // can be called a fault; a late tick contaminates this reading too.
    if (
        input.heightsSubscribers >= 1 &&
        input.now - input.lastInboundAt > INBOUND_SILENCE_MS &&
        input.tickLateMs <= TICK_LATE_TOLERANCE_MS
    ) {
        return { kind: "silent" }
    }
    return { kind: "ok" }
}

/** Sliding-window restart budget: the restart that exceeds it is refused. */
export class RestartBudget {
    private readonly stamps: number[] = []
    constructor(
        private readonly max: number,
        private readonly windowMs: number,
    ) {}

    /** Record a restart; returns false when the budget is exhausted. */
    take(now: number): boolean {
        while (this.stamps.length > 0 && now - this.stamps[0] > this.windowMs) {
            this.stamps.shift()
        }
        if (this.stamps.length >= this.max) return false
        this.stamps.push(now)
        return true
    }

    used(now: number): number {
        return this.stamps.filter(t => now - t <= this.windowMs).length
    }
}
