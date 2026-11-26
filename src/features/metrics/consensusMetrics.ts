import { getMetricsService } from "./MetricsService"

/**
 * Write-side helpers for the consensus health metrics. Each one swallows its
 * own errors: a metrics failure must never reach the consensus path that calls it.
 */

/**
 * Transactions of a block this node stored, by final status. The type label
 * stays "all": a tx type read from a peer's block would let it grow the label
 * set without bound.
 */
export function countIncludedTransactions(
    txs: ReadonlyArray<{ status?: string }>,
): void {
    try {
        let failed = 0
        for (const tx of txs) {
            if (tx.status === "failed") failed++
        }
        const confirmed = txs.length - failed
        const metrics = getMetricsService()
        if (confirmed > 0) {
            metrics.incrementCounter(
                "transactions_total",
                { type: "all", status: "confirmed" },
                confirmed,
            )
        }
        if (failed > 0) {
            metrics.incrementCounter(
                "transactions_total",
                { type: "all", status: "failed" },
                failed,
            )
        }
    } catch {
        /* ignore */
    }
}

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

export function countCommitLock(): void {
    try {
        getMetricsService().incrementCounter("commit_lock_total")
    } catch {
        /* ignore */
    }
}

export function countLockMoved(): void {
    try {
        getMetricsService().incrementCounter("lock_moved_total")
    } catch {
        /* ignore */
    }
}

export function countPrecommitEquivocation(): void {
    try {
        getMetricsService().incrementCounter("precommit_equivocation_total")
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

export function countStorageRootSyncMismatch(): void {
    try {
        getMetricsService().incrementCounter(
            "storage_root_sync_mismatch_total",
        )
    } catch {
        /* ignore */
    }
}

export function countStorageProofRootMismatch(): void {
    try {
        getMetricsService().incrementCounter(
            "storage_proof_root_mismatch_total",
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

// The height the series below hold up; 0 while none are set.
let committeeOfflineHeight = 0

/**
 * Names the bound committee members this node sees offline while too few are
 * live to forge `height`. Every retry at a height draws the same committee, so
 * these are the validators operators must bring back. The series are replaced
 * on each call, so only the current committee is ever exported.
 */
export function setCommitteeOffline(height: number, offline: string[]): void {
    try {
        const metrics = getMetricsService()
        metrics.resetGauge("committee_member_offline")
        committeeOfflineHeight = offline.length > 0 ? height : 0
        for (const identity of offline) {
            metrics.setGauge("committee_member_offline", height, {
                identity: identity.toLowerCase(),
            })
        }
    } catch {
        /* ignore */
    }
}

/**
 * Clears the series once the height they hold up is committed: a node that
 * stops drawing committees (syncing, shutting down) must not keep naming them.
 */
export function clearCommitteeOfflineAtOrBelow(lastBlockNumber: number): void {
    if (committeeOfflineHeight === 0 || lastBlockNumber < committeeOfflineHeight) {
        return
    }
    setCommitteeOffline(0, [])
}
