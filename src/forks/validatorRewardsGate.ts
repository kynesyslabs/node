import { getSharedState } from "@/utilities/sharedState"
import { isForkActive } from "./forkGates"

/** The one bucket an incentive award may name under `validatorRewards`. */
export const VALIDATOR_REWARDS_BUCKET = "validatorRewards"

/**
 * Whether `validatorRewards` binds. Judged at the tip at admission and at
 * apply alike, so an award admitted against the tip is credited by the same
 * rule when the block on that tip applies.
 */
export function validatorRewardsActive(height = getSharedState.lastBlockNumber ?? 0): boolean {
    return isForkActive("validatorRewards", height)
}

/** Why an award naming `bucket` is refused, or null. An award naming none is never refused here. */
export function awardBucketRefusal(bucket: unknown): string | null {
    if (bucket === undefined) return null
    if (!validatorRewardsActive()) return "an award names a points bucket only once validatorRewards is active"
    if (bucket !== VALIDATOR_REWARDS_BUCKET) return `unknown points bucket ${JSON.stringify(bucket)}`
    return null
}
