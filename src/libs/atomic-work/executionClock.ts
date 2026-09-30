/**
 * The only time an atomic Work is allowed to know.
 *
 * A deadline decided by wall-clock time is not a rule: two validators reading
 * their own clocks disagree about whether the same Work expired, and the
 * submitter's clock is not evidence of anything at all. The time a Work is
 * judged against is the one consensus already agreed on for the block it lands
 * in — every validator reads the same number, and the submitter cannot choose
 * it.
 *
 * So the clock is a value handed down from block assembly, not something this
 * module can fetch. There is no function here that reads the host clock, and
 * nothing accepts a timestamp carried by a transaction: a caller with only a
 * client-supplied number cannot build a clock, which is the point.
 *
 * Fail-closed throughout. A missing or unusable clock refuses the evaluation
 * instead of standing in for "now" — an absent time silently treated as zero
 * expires everything, and treated as the host clock expires nothing
 * reproducibly.
 */

export interface ExecutionClock {
    /** Consensus-agreed block time, milliseconds since the epoch. */
    consensusTimeMs: number
    /** The block that time belongs to. */
    blockHeight: number
}

export class ExecutionClockError extends Error {
    constructor(
        message: string,
        readonly reason: "no-clock" | "malformed-time" | "malformed-height",
    ) {
        super(message)
        this.name = "ExecutionClockError"
    }
}

export class DeadlineError extends Error {
    constructor(
        message: string,
        readonly reason: "expired" | "not-yet-valid",
        readonly consensusTimeMs: number,
        readonly boundaryMs: number,
    ) {
        super(message)
        this.name = "DeadlineError"
    }
}

/**
 * Build the clock for a block.
 *
 * The only constructor, and it validates rather than coerces: a timestamp that
 * is not a positive safe integer is a broken block header, and guessing what
 * was meant would make expiry depend on the guess.
 */
export function executionClock(blockHeight: number, consensusTimeMs: number): ExecutionClock {
    if (!Number.isSafeInteger(consensusTimeMs) || consensusTimeMs <= 0) {
        throw new ExecutionClockError(
            `consensus time must be a positive whole number of milliseconds, got ${consensusTimeMs}`,
            "malformed-time",
        )
    }
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
        throw new ExecutionClockError(
            `block height must be a non-negative whole number, got ${blockHeight}`,
            "malformed-height",
        )
    }
    return { consensusTimeMs, blockHeight }
}

function requireClock(clock: ExecutionClock | undefined, what: string): ExecutionClock {
    if (!clock) {
        throw new ExecutionClockError(
            `${what} needs the consensus block time, and none was supplied`,
            "no-clock",
        )
    }
    return clock
}

/**
 * Refuse a Work whose deadline has passed.
 *
 * The boundary is inclusive: a Work whose deadline is exactly this block's
 * time is still in time. Deadlines are written by people who mean "by then",
 * and an off-by-one here is a Work rejected for being punctual.
 */
export function assertWithinDeadline(
    clock: ExecutionClock | undefined,
    deadlineMs: number,
    what = "this operation",
): void {
    const resolved = requireClock(clock, what)
    if (!Number.isSafeInteger(deadlineMs)) {
        throw new ExecutionClockError(
            `${what} has a malformed deadline: ${deadlineMs}`,
            "malformed-time",
        )
    }
    if (resolved.consensusTimeMs > deadlineMs) {
        throw new DeadlineError(
            `${what} expired at ${deadlineMs}; block ${resolved.blockHeight} is at ${resolved.consensusTimeMs}`,
            "expired",
            resolved.consensusTimeMs,
            deadlineMs,
        )
    }
}

/** Refuse a Work presented before the time it becomes valid. */
export function assertNotBefore(
    clock: ExecutionClock | undefined,
    notBeforeMs: number,
    what = "this operation",
): void {
    const resolved = requireClock(clock, what)
    if (!Number.isSafeInteger(notBeforeMs)) {
        throw new ExecutionClockError(
            `${what} has a malformed validity start: ${notBeforeMs}`,
            "malformed-time",
        )
    }
    if (resolved.consensusTimeMs < notBeforeMs) {
        throw new DeadlineError(
            `${what} is not valid until ${notBeforeMs}; block ${resolved.blockHeight} is at ${resolved.consensusTimeMs}`,
            "not-yet-valid",
            resolved.consensusTimeMs,
            notBeforeMs,
        )
    }
}

/** Both bounds at once, for a validity window. */
export function assertWithinWindow(
    clock: ExecutionClock | undefined,
    window: { notBeforeMs?: number | null; deadlineMs?: number | null },
    what = "this operation",
): void {
    const resolved = requireClock(clock, what)
    if (typeof window.notBeforeMs === "number") {
        assertNotBefore(resolved, window.notBeforeMs, what)
    }
    if (typeof window.deadlineMs === "number") {
        assertWithinDeadline(resolved, window.deadlineMs, what)
    }
}
