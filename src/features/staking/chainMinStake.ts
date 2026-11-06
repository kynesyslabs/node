import { getSharedState } from "src/utilities/sharedState"
import { DEFAULT_MIN_VALIDATOR_STAKE } from "./constants"

/**
 * The minimum stake block apply holds a validator to: the value an active
 * network upgrade set, else the protocol default. Never the operator's own
 * setting, which would let nodes apply the same stake differently.
 */
export function chainMinValidatorStake(): bigint {
    const governed = getSharedState.governedMinValidatorStake
    if (typeof governed === "string" && governed.length > 0) {
        try {
            return BigInt(governed)
        } catch {
            /* fall through */
        }
    }
    return BigInt(DEFAULT_MIN_VALIDATOR_STAKE)
}
