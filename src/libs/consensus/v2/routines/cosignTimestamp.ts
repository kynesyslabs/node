/**
 * Which block timestamps an honest member signs. This is a signing policy,
 * not a validity rule: sync keeps its own, wider bound, so tightening it
 * changes what this node signs, never which stored blocks verify.
 *
 * The secretary picks the timestamp, and the block hash covers it. Through
 * the hash it feeds the common validator seed, so every timestamp the
 * members accept is another committee draw the secretary can choose from.
 * Holding it to an integer close to our own clock leaves the secretary a
 * handful of values instead of a minute's worth (or, with fractions, an
 * unlimited number).
 */

/**
 * How far a block timestamp may lead our network clock and still be signed.
 * An honest secretary stamps the block with its own network time when the
 * round opens, so the stamp reaches a member already in the member's past.
 * Only disagreement between NTP-calibrated clocks can put it ahead, and the
 * calibration works in whole seconds, so a few seconds cover it. A larger
 * lead is a value chosen for its effect on the block hash.
 */
export const COSIGN_TIMESTAMP_MAX_LEAD_SECONDS = 5

export interface CosignTimestampVerdict {
    valid: boolean
    reason?: string
}

/** Thrown before signing a block whose timestamp fails the signing policy. */
export class CosignTimestampError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "CosignTimestampError"
    }
}

/**
 * Whether we sign a block stamped `timestamp` when our network clock reads
 * `now`: a whole number of seconds, at most
 * COSIGN_TIMESTAMP_MAX_LEAD_SECONDS ahead of us. The lower bound is the
 * parent check's job.
 */
export function checkCosignTimestamp(
    timestamp: unknown,
    now: number,
): CosignTimestampVerdict {
    if (typeof timestamp !== "number" || !Number.isInteger(timestamp)) {
        return {
            valid: false,
            reason: `block timestamp ${String(timestamp)} is not a whole number of seconds`,
        }
    }
    const ceiling = now + COSIGN_TIMESTAMP_MAX_LEAD_SECONDS
    if (timestamp > ceiling) {
        return {
            valid: false,
            reason: `block timestamp ${timestamp} is ${timestamp - now}s ahead of our clock (at most ${COSIGN_TIMESTAMP_MAX_LEAD_SECONDS}s signed)`,
        }
    }
    return { valid: true }
}
