import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/** The one bucket an incentive award may name under `validatorRewards`. */
export const VALIDATOR_REWARDS_BUCKET = "validatorRewards"

/** What an `awardPoints` call names for the account's ordinary points; such an award carries no bucket. */
export const ORDINARY_POINTS_BUCKET = "weeklyChallenge"

const BUCKET_OPTIONS =
    `"${ORDINARY_POINTS_BUCKET}" (the account's ordinary points) or ` +
    `"${VALIDATOR_REWARDS_BUCKET}" (validator points, kept apart from the others)`

/**
 * Whether `validatorRewards` binds. Judged at the tip at admission and at
 * apply alike, so an award admitted against the tip is credited by the same
 * rule when the block on that tip applies.
 */
export function validatorRewardsActive(height = getSharedState.lastBlockNumber ?? 0): boolean {
    return isForkActive("validatorRewards", height)
}

/**
 * Why an award transaction naming `bucket` is refused under the fork, or
 * null. One naming none is an ordinary award.
 */
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
    if (bucket === VALIDATOR_REWARDS_BUCKET && !validatorRewardsActive()) {
        return (
            `bucket "${VALIDATOR_REWARDS_BUCKET}" is not available: the validatorRewards fork is not active ` +
            `on this network, so only "${ORDINARY_POINTS_BUCKET}" can be named`
        )
    }
    return null
}
