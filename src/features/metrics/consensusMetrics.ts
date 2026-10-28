import { getMetricsService } from "./MetricsService"

/**
 * Write-side helpers for the consensus health metrics. Each one swallows its
 * own errors: a metrics failure must never reach the consensus path that calls it.
 */

export function countBlockHashMismatch(): void {
    try {
        getMetricsService().incrementCounter(
            "consensus_block_hash_mismatch_total",
        )
    } catch {
        /* ignore */
    }
}

export function countConflictingBlock(): void {
    try {
        getMetricsService().incrementCounter("conflicting_block_total")
    } catch {
        /* ignore */
    }
}

export function countMissedSignature(): void {
    try {
        getMetricsService().incrementCounter(
            "consensus_missed_signatures_total",
        )
    } catch {
        /* ignore */
    }
}

export function setForkScheduleMismatch(mismatch: boolean): void {
    try {
        getMetricsService().setGauge("fork_schedule_mismatch", mismatch ? 1 : 0)
    } catch {
        /* ignore */
    }
}

export function setConsensusAbstaining(abstaining: boolean): void {
    try {
        getMetricsService().setGauge(
            "consensus_abstaining",
            abstaining ? 1 : 0,
        )
    } catch {
        /* ignore */
    }
}
