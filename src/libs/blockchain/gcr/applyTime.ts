import { AsyncLocalStorage } from "node:async_hooks"

/**
 * The time block apply stamps into state: the block's own timestamp, so
 * every node applying the block, and every node syncing it later, stores
 * the same bytes. Kept in async context because the routines that stamp it
 * (points, referrals, attestations) run deep below the apply loop, and some
 * of them only after the block commits.
 */
const blockTime = new AsyncLocalStorage<number>()

/** Runs `fn` with apply time set to the block's timestamp, in seconds. */
export function withBlockTime<T>(timestampSec: number | undefined, fn: () => T): T {
    if (timestampSec === undefined || !Number.isFinite(timestampSec)) return fn()
    return blockTime.run(timestampSec * 1000, fn)
}

/**
 * `fn` bound to the apply time in force now, for work that runs later:
 * side effects after the commit, writes inside the block's transaction.
 */
export function bindApplyTime<A extends unknown[], R>(
    fn: (...args: A) => R,
): (...args: A) => R {
    const ms = blockTime.getStore()
    if (ms === undefined) return fn
    return (...args: A) => blockTime.run(ms, () => fn(...args))
}

/**
 * The time to stamp: the applied block's timestamp. Outside block apply
 * (reads, admission dry runs, an orphan rollback, which has no block to
 * read it from) the wall clock is used.
 */
export function applyTime(): Date {
    const ms = blockTime.getStore()
    return new Date(ms ?? Date.now())
}
