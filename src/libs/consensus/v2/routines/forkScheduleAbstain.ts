import { getSharedState } from "src/utilities/sharedState"

/**
 * The reason this node must sit out the coming consensus round, or null when it
 * may take part. The flag is owned by the fork-schedule watch, which sets it
 * when a peer's schedule differs inside the window before a fork and clears it
 * once a later comparison finds agreement.
 */
export function forkScheduleAbstainReason(): string | null {
    if (!getSharedState.forkScheduleAbstain) return null
    return (
        getSharedState.forkScheduleAbstainReason ||
        "fork schedule differs from the peers'"
    )
}

const LOG_EVERY_MS = 60_000
let lastLoggedAt: number | null = null

/**
 * Whether this round's abstain line should be logged. Rounds come every few
 * seconds, so an unthrottled line would bury the log for as long as the node
 * stays out; the transition itself is logged once by the watch.
 */
export function shouldLogForkScheduleAbstain(now: number = Date.now()): boolean {
    if (lastLoggedAt !== null && now - lastLoggedAt < LOG_EVERY_MS) return false
    lastLoggedAt = now
    return true
}

export function resetForkScheduleAbstainLogThrottle(): void {
    lastLoggedAt = null
}
