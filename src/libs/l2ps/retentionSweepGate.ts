/**
 * Rate limit for a periodic sweep that is far cheaper to skip than to run.
 *
 * The caller asks on every cycle; the gate answers yes at most once per
 * interval. A sweep counts from the moment it is granted, not from its
 * outcome, so a failed sweep also waits a full interval: retrying a scan that
 * just failed on the next ten-second cycle would only repeat the failure.
 */
export class RetentionSweepGate {
    private last: number | null = null

    constructor(
        private readonly intervalMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    /** True when a sweep is due; the grant is recorded before returning. */
    due(): boolean {
        const t = this.now()
        if (this.last !== null && t - this.last < this.intervalMs) return false
        this.last = t
        return true
    }
}
