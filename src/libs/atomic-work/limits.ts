import { jcsCanonicalize } from "@/libs/crypto/jcs"

/**
 * What a node refuses to execute at all.
 *
 * Limits are not tuning knobs here. Every validator has to reach the same
 * verdict on the same Work, so "too big" cannot mean "bigger than this
 * machine felt like handling" — the thresholds are declared, enforced
 * identically everywhere, and published with the capability so a submitter
 * can tell in advance what will be refused.
 *
 * Size and shape are checked before execution, where a refusal costs nothing.
 * The execution budget is the exception: it can only be observed while running,
 * so it aborts into a rollback rather than a pre-admission refusal.
 */

export interface AtomicWorkLimits {
    maxCanonicalBytes: number
    maxOperations: number
    maxExecutionTimeMs: number
    maxProofBytes: number
}

export const DEFAULT_ATOMIC_WORK_LIMITS: AtomicWorkLimits = {
    maxCanonicalBytes: 65_536,
    maxOperations: 32,
    maxExecutionTimeMs: 2_000,
    maxProofBytes: 16_384,
}

export class LimitExceededError extends Error {
    constructor(
        message: string,
        readonly limit: keyof AtomicWorkLimits,
        readonly actual: number,
        readonly allowed: number,
    ) {
        super(message)
        this.name = "LimitExceededError"
    }
}

/** Bytes of the canonical form — what is hashed, not what was sent. */
export function canonicalByteLength(value: unknown): number {
    return Buffer.byteLength(jcsCanonicalize(value), "utf8")
}

/**
 * Refuse an intent that is too large or too long before anything executes.
 *
 * Checked on the canonical bytes rather than the received payload: the
 * received form can be padded or minified without changing what is hashed, so
 * a limit on it would be a limit on formatting.
 */
export function assertIntentWithinLimits(
    intent: { operations?: unknown[] },
    limits: AtomicWorkLimits,
): void {
    const operations = intent.operations?.length ?? 0
    if (operations > limits.maxOperations) {
        throw new LimitExceededError(
            `Work declares ${operations} operations; this node executes at most ${limits.maxOperations}`,
            "maxOperations",
            operations,
            limits.maxOperations,
        )
    }
    const bytes = canonicalByteLength(intent)
    if (bytes > limits.maxCanonicalBytes) {
        throw new LimitExceededError(
            `Work is ${bytes} canonical bytes; this node executes at most ${limits.maxCanonicalBytes}`,
            "maxCanonicalBytes",
            bytes,
            limits.maxCanonicalBytes,
        )
    }
}

/** Refuse a proof too large to be worth verifying or storing. */
export function assertProofWithinLimits(
    proofBytes: number,
    limits: AtomicWorkLimits,
): void {
    if (proofBytes > limits.maxProofBytes) {
        throw new LimitExceededError(
            `proof is ${proofBytes} bytes; this node accepts at most ${limits.maxProofBytes}`,
            "maxProofBytes",
            proofBytes,
            limits.maxProofBytes,
        )
    }
}

/**
 * Abort a Work that has run past its budget.
 *
 * Unlike the others this is discovered mid-execution, so the caller rolls back
 * rather than refusing admission — the overlay has staged effects by now and
 * they must go nowhere.
 */
export function assertExecutionWithinBudget(
    elapsedMs: number,
    limits: AtomicWorkLimits,
): void {
    if (elapsedMs > limits.maxExecutionTimeMs) {
        throw new LimitExceededError(
            `Work ran ${elapsedMs}ms; this node allows ${limits.maxExecutionTimeMs}ms before rolling back`,
            "maxExecutionTimeMs",
            elapsedMs,
            limits.maxExecutionTimeMs,
        )
    }
}
