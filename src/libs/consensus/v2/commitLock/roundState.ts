import type { LockInputs } from "./lockStore"

/**
 * The prevote this process signed last, and whether it may still be
 * followed by a precommit. A member precommits only in the round of its
 * latest prevote, and only until it starts choosing the candidate of its
 * next attempt: a precommit for an older round after a newer prevote would
 * let one member back a proof of lock in a later round and a certificate in
 * an earlier one, which is what the lock rule exists to prevent.
 *
 * In memory only: after a restart nothing is open, so a precommit request
 * for a round from before the restart is refused.
 */
export interface PrevoteState {
    height: number
    round: number
    hash: string
    inputs: LockInputs
    open: boolean
}

let latest: PrevoteState | null = null

export function recordPrevote(state: Omit<PrevoteState, "open">): void {
    latest = { ...state, open: true }
}

/** Called under the lock mutex before a new attempt picks its candidate. */
export function closePrevotes(): void {
    if (latest) latest.open = false
}

/** The open prevote of exactly this height, round and block, else null. */
export function openPrevote(
    height: number,
    round: number,
    hash: string,
): PrevoteState | null {
    if (
        !latest?.open ||
        latest.height !== height ||
        latest.round !== round ||
        latest.hash !== hash
    ) {
        return null
    }
    return latest
}

export function latestPrevote(): PrevoteState | null {
    return latest
}

// Lock decisions, lock writes, precommit signatures and the closing of a
// round run one at a time: the consensus routine and the precommit handler
// act on the same lock from different requests.
let tail: Promise<unknown> = Promise.resolve()

export function withLockMutex<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = tail.then(() => fn())
    tail = run.catch(() => undefined)
    return run
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetRoundState(): void {
    latest = null
    tail = Promise.resolve()
}
