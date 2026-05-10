import { getSharedState } from "@/utilities/sharedState"
import type { ForkName } from "./forkConfig"

// REVIEW: P2 — gate function; defaults to inactive when activationHeight is null.

/**
 * Returns true iff the named fork is active at the given block height.
 *
 * A fork is considered active when:
 *  - its `activationHeight` is non-null, AND
 *  - `blockHeight >= activationHeight`.
 *
 * Defensive behavior:
 *  - If `forkConfig` is missing on `SharedState` (e.g. tests booting without
 *    full startup), the function reports the fork as inactive.
 *  - Unknown / typo'd fork names also report inactive. Compile-time typing
 *    should normally prevent this, but the runtime check protects against
 *    explicit casts.
 *
 * @param forkName Registered fork identifier from {@link ForkName}.
 * @param blockHeight Height to evaluate against. Genesis is height `0`.
 * @returns Whether the fork's rules apply at `blockHeight`.
 */
export function isForkActive(forkName: ForkName, blockHeight: number): boolean {
    const config = getSharedState.forkConfig?.[forkName]
    if (!config || config.activationHeight === null) return false
    return blockHeight >= config.activationHeight
}
