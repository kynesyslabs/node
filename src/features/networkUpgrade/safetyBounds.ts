// Tri-layer safety bounds for governance proposals.
// Layer 1 — percentage cap: no single proposal may change a numeric value by
//           more than MAX_CHANGE_PERCENT in either direction.
//           DEM-665: distribution keys use the tighter
//           DISTRIBUTION_MAX_CHANGE_PERCENT (±10% by default).
// Layer 2 — absolute floor/ceiling: each tunable parameter has a hard-coded
//           acceptable range the governance system cannot override.
// Layer 3 — DEM-665 cross-key sum-100 invariant: the merged (current ⊕
//           proposed) view of each distribution group must add to exactly
//           100.
//
// Returns {ok:true} iff every proposed key passes ALL three layers.
// Non-numeric parameters (featureFlags) are exempt from percentage/floor
// checks but their values must still be booleans.
//
// Called from validateNetworkUpgradeTx (Phase 1 tx validation) and directly
// unit-tested below.

import {
    DISTRIBUTION_KEYS,
    DISTRIBUTION_MAX_CHANGE_PERCENT,
    getBigintBounds,
    MAX_CHANGE_PERCENT,
    NUMERIC_BOUNDS,
    PHASE_1_GOVERNABLE_KEYS,
} from "./constants"
import type { NetworkParameterKey, NetworkParameters } from "./types"

export type BoundsCheck =
    | { ok: true }
    | { ok: false; key: NetworkParameterKey; reason: string }

/**
 * Validates that `proposed` is a permissible transition from `current` under
 * both layers of safety bounds.
 */
export function checkSafetyBounds(
    current: NetworkParameters,
    proposed: Partial<NetworkParameters>,
): BoundsCheck {
    const proposedKeys = Object.keys(proposed) as NetworkParameterKey[]
    if (proposedKeys.length === 0) {
        return { ok: false, key: "networkFee", reason: "empty proposal" }
    }

    for (const key of proposedKeys) {
        if (!PHASE_1_GOVERNABLE_KEYS.has(key)) {
            return {
                ok: false,
                key,
                reason: `parameter ${key} is not governable in Phase 1`,
            }
        }

        if (key === "featureFlags") {
            const check = checkFeatureFlags(proposed.featureFlags)
            if (check.ok === false) {
                return { ok: false, key, reason: check.reason }
            }
            continue
        }

        const currentValue = current[key]
        const proposedValue = proposed[key]

        if (typeof currentValue === "number") {
            if (typeof proposedValue !== "number") {
                return {
                    ok: false,
                    key,
                    reason: `expected number, got ${typeof proposedValue}`,
                }
            }
            const numCheck = checkNumericBounds(
                key,
                currentValue,
                proposedValue,
            )
            if (!numCheck.ok) return numCheck
            continue
        }

        if (typeof currentValue === "string") {
            if (typeof proposedValue !== "string") {
                return {
                    ok: false,
                    key,
                    reason: `expected bigint-string, got ${typeof proposedValue}`,
                }
            }
            const bigCheck = checkBigintBounds(
                key,
                currentValue,
                proposedValue,
            )
            if (!bigCheck.ok) return bigCheck
            continue
        }

        return {
            ok: false,
            key,
            reason: "unsupported parameter type for safety check",
        }
    }

    // DEM-665 — Layer 3: cross-key sum-100 invariant on distribution
    // groups. Runs on the MERGED view so a proposal touching one
    // percentage key only is validated against the not-yet-changed
    // siblings (e.g. raising networkFeeBurnPct from 50 to 55 implies
    // networkFeeTreasuryPct must drop to 45 — that key has to be in
    // the same proposal, or the merged view fails to sum to 100).
    const sumCheck = checkDistributionSumInvariant(current, proposed)
    if (!sumCheck.ok) return sumCheck

    return { ok: true }
}

/**
 * DEM-665 — verifies that any distribution group touched by `proposed`
 * still sums to exactly 100 once merged onto `current`. Untouched
 * groups are skipped (they were valid in `current` by construction).
 *
 * Groups:
 *  - network_fee:    burnPct + treasuryPct                === 100
 *  - additional_fee: burnPct + treasuryPct                === 100
 *  - special_ops:    burnPct + treasuryPct + rpcPct       === 100
 *
 * Returns the first failing group; callers stop on first failure.
 */
function checkDistributionSumInvariant(
    current: NetworkParameters,
    proposed: Partial<NetworkParameters>,
): BoundsCheck {
    const groups: Array<{
        name: string
        keys: NetworkParameterKey[]
    }> = [
        {
            name: "network_fee",
            keys: ["networkFeeBurnPct", "networkFeeTreasuryPct"],
        },
        {
            name: "additional_fee",
            keys: ["additionalFeeBurnPct", "additionalFeeTreasuryPct"],
        },
        {
            name: "special_ops",
            keys: [
                "specialOpsBurnPct",
                "specialOpsTreasuryPct",
                "specialOpsRpcPct",
            ],
        },
    ]
    for (const { name, keys } of groups) {
        const touched = keys.some(k => k in proposed)
        if (!touched) continue
        let sum = 0
        for (const k of keys) {
            const v =
                k in proposed
                    ? (proposed[k] as number)
                    : (current[k] as number)
            sum += v
        }
        if (sum !== 100) {
            // Return the first proposed key in the group as the
            // diagnostic-bearing key.
            const reporter = keys.find(k => k in proposed) ?? keys[0]
            return {
                ok: false,
                key: reporter,
                reason: `distribution sum invariant violated for ${name}: merged sum=${sum}, must equal 100`,
            }
        }
    }
    return { ok: true }
}

function checkFeatureFlags(
    flags: Record<string, boolean> | undefined,
): { ok: true } | { ok: false; reason: string } {
    if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
        return { ok: false, reason: "featureFlags must be a plain object" }
    }
    for (const [k, v] of Object.entries(flags)) {
        if (typeof v !== "boolean") {
            return {
                ok: false,
                reason: `featureFlags.${k} must be boolean, got ${typeof v}`,
            }
        }
    }
    return { ok: true }
}

function checkNumericBounds(
    key: NetworkParameterKey,
    current: number,
    proposed: number,
): BoundsCheck {
    if (!Number.isFinite(proposed) || !Number.isInteger(proposed)) {
        return {
            ok: false,
            key,
            reason: "proposed must be a finite integer",
        }
    }
    const bounds = NUMERIC_BOUNDS[key]
    if (bounds) {
        if (proposed < bounds.floor) {
            return {
                ok: false,
                key,
                reason: `proposed ${proposed} below floor ${bounds.floor}`,
            }
        }
        if (proposed > bounds.ceiling) {
            return {
                ok: false,
                key,
                reason: `proposed ${proposed} above ceiling ${bounds.ceiling}`,
            }
        }
    }
    // DEM-665: distribution-percentage keys use the tighter ±10% cap.
    const cap = DISTRIBUTION_KEYS.has(key)
        ? DISTRIBUTION_MAX_CHANGE_PERCENT
        : MAX_CHANGE_PERCENT
    if (!withinPercentCap(BigInt(current), BigInt(proposed), cap)) {
        return {
            ok: false,
            key,
            reason: `proposed ${proposed} exceeds ${cap}% change vs current ${current}`,
        }
    }
    return { ok: true }
}

function checkBigintBounds(
    key: NetworkParameterKey,
    current: string,
    proposed: string,
): BoundsCheck {
    let currentBig: bigint
    let proposedBig: bigint
    try {
        currentBig = BigInt(current)
        proposedBig = BigInt(proposed)
    } catch {
        return { ok: false, key, reason: "non-numeric bigint string" }
    }

    const bounds = getBigintBounds()[key]
    if (bounds) {
        const floor = BigInt(bounds.floor)
        if (proposedBig < floor) {
            return {
                ok: false,
                key,
                reason: `proposed ${proposed} below floor ${bounds.floor}`,
            }
        }
        if (bounds.ceiling !== null) {
            const ceiling = BigInt(bounds.ceiling)
            if (proposedBig > ceiling) {
                return {
                    ok: false,
                    key,
                    reason: `proposed ${proposed} above ceiling ${bounds.ceiling}`,
                }
            }
        }
    }
    if (!withinPercentCap(currentBig, proposedBig, MAX_CHANGE_PERCENT)) {
        return {
            ok: false,
            key,
            reason: `proposed ${proposed} exceeds ${MAX_CHANGE_PERCENT}% change vs current ${current}`,
        }
    }
    return { ok: true }
}

/**
 * True iff |proposed - current| <= (cap / 100) * |current|.
 * Bigint-only to avoid floating-point drift.
 *
 * DEM-665: `cap` is now a parameter (rather than a hardcoded constant)
 * so distribution keys can use the tighter ±DISTRIBUTION_MAX_CHANGE_PERCENT
 * while everything else keeps the historical ±MAX_CHANGE_PERCENT.
 *
 * Edge cases:
 * - current = 0: percent cap is undefined (delta / 0). Allow any non-negative
 *   proposed value so governance can lift a parameter that was initialised
 *   at zero (e.g. operator set NETWORK_FEE=0 via env). A purely
 *   percent-based cap would lock the parameter at 0 forever — the
 *   absolute-value caps (e.g. MAX_NETWORK_FEE) still apply at the
 *   per-key check sites.
 */
function withinPercentCap(
    current: bigint,
    proposed: bigint,
    cap: number,
): boolean {
    const absCurrent = current < 0n ? -current : current
    if (absCurrent === 0n) return proposed >= 0n
    const delta =
        proposed >= current ? proposed - current : current - proposed
    // delta * 100 <= absCurrent * cap
    return delta * 100n <= absCurrent * BigInt(cap)
}
