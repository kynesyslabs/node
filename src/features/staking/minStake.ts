import { getSharedState } from "src/utilities/sharedState"
import { DEFAULT_MIN_VALIDATOR_STAKE } from "./constants"

/**
 * Current minimum stake required to take a validator seat. Prefers the
 * governed network parameter and falls back to the default before
 * governance has loaded.
 */
export function getMinValidatorStake(): bigint {
    const governed = (
        getSharedState.networkParameters as {
            minValidatorStake?: string
        } | null
    )?.minValidatorStake
    if (typeof governed === "string" && governed.length > 0) {
        try {
            return BigInt(governed)
        } catch {
            /* fall through */
        }
    }
    return BigInt(DEFAULT_MIN_VALIDATOR_STAKE)
}
