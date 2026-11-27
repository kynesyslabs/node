/** The one bucket an incentive award transaction may name: validator points, kept apart from the others. */
export const VALIDATOR_REWARDS_BUCKET = "validatorRewards"

/** What an `awardPoints` call names for the account's ordinary points; such an award carries no bucket. */
export const ORDINARY_POINTS_BUCKET = "weeklyChallenge"

const BUCKET_OPTIONS =
    `"${ORDINARY_POINTS_BUCKET}" (the account's ordinary points) or ` +
    `"${VALIDATOR_REWARDS_BUCKET}" (validator points, kept apart from the others)`

/** Why an award transaction naming `bucket` is refused, or null. One naming none is an ordinary award. */
export function awardBucketRefusal(bucket: unknown): string | null {
    if (bucket === undefined || bucket === VALIDATOR_REWARDS_BUCKET) return null
    return `unknown points bucket ${JSON.stringify(bucket)}`
}

/**
 * Why an `awardPoints` call naming `bucket` is refused, or null. The call
 * must say which points it awards, so a validator award cannot land in the
 * ordinary points by omission.
 */
export function awardCallBucketRefusal(bucket: unknown): string | null {
    if (bucket === undefined || bucket === null) return `bucket is required: name ${BUCKET_OPTIONS}`
    if (bucket !== ORDINARY_POINTS_BUCKET && bucket !== VALIDATOR_REWARDS_BUCKET) {
        return `unknown bucket ${JSON.stringify(bucket)}: name ${BUCKET_OPTIONS}`
    }
    return null
}
