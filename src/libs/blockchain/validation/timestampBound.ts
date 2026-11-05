import { getSharedState } from "@/utilities/sharedState"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import type { BlockVerification } from "./verifyBlock"

/**
 * The upper bound on a block timestamp: at most the configured tolerance
 * ahead of this node's clock. Sync applies it to fetched blocks and the vote
 * path before signing, so the node never signs a block it would refuse later.
 */
export function checkTimestampNotAhead(
    blockTimestamp: number,
    now: number = getNetworkTimestamp(),
): BlockVerification {
    const tolerance = getSharedState.getBlockTimestampTolerance()
    if (blockTimestamp > now + tolerance) {
        return {
            valid: false,
            reason: `block timestamp ${blockTimestamp} is ${blockTimestamp - now}s in the verifier's future (tolerance ${tolerance}s)`,
        }
    }
    return { valid: true }
}
