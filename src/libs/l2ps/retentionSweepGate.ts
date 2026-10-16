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
        // A reading that is not a time is no evidence an interval has passed,
        // and recording it would make every later comparison false.
        if (!Number.isFinite(t)) return false
        // A reading before the last grant means the clock was stepped back.
        // Granting on it would give one extra sweep for every wobble; staying
        // shut until the old baseline is reached would silence retention for
        // the size of the step. So the baseline moves to the new reading and
        // the next sweep is an interval after it.
        if (this.last !== null && t < this.last) {
            this.last = t
            return false
        }
        if (this.last !== null && t - this.last < this.intervalMs) return false
        this.last = t
        return true
    }
}
