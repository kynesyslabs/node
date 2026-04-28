// Dual-layer safety bounds for governance proposals.
// Layer 1 — percentage cap: no single proposal may change a numeric value by
//           more than MAX_CHANGE_PERCENT in either direction.
// Layer 2 — absolute floor/ceiling: each tunable parameter has a hard-coded
//           acceptable range the governance system cannot override.
//
// Returns {ok:true} iff every proposed key passes BOTH layers. Non-numeric
// parameters (featureFlags) are exempt from percentage/floor checks but their
// values must still be booleans.
//
// Called from validateNetworkUpgradeTx (Phase 1 tx validation) and directly
// unit-tested below.

import {
    BIGINT_BOUNDS,
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
    return { ok: true }
}

function checkFeatureFlags(
    flags: Record<string, boolean> | undefined,
): { ok: true } | { ok: false; reason: string } {
    if (!flags || typeof flags !== "object") {
        return { ok: false, reason: "featureFlags must be an object" }
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
    if (!Number.isFinite(proposed)) {
        return { ok: false, key, reason: "non-finite proposed value" }
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
    if (!withinPercentCap(BigInt(current), BigInt(proposed))) {
        return {
            ok: false,
            key,
            reason: `proposed ${proposed} exceeds ${MAX_CHANGE_PERCENT}% change vs current ${current}`,
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

    const bounds = BIGINT_BOUNDS[key]
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
    if (!withinPercentCap(currentBig, proposedBig)) {
        return {
            ok: false,
            key,
            reason: `proposed ${proposed} exceeds ${MAX_CHANGE_PERCENT}% change vs current ${current}`,
        }
    }
    return { ok: true }
}

/**
 * True iff |proposed - current| <= (MAX_CHANGE_PERCENT / 100) * |current|.
 * Bigint-only to avoid floating-point drift.
 *
 * Edge cases:
 * - current = 0: any non-zero proposed value is unbounded-growth and rejected.
 *   A proposed value of 0 is allowed.
 */
function withinPercentCap(current: bigint, proposed: bigint): boolean {
    const absCurrent = current < 0n ? -current : current
    if (absCurrent === 0n) return proposed === 0n
    const delta =
        proposed >= current ? proposed - current : current - proposed
    // delta * 100 <= absCurrent * MAX_CHANGE_PERCENT
    return delta * 100n <= absCurrent * BigInt(MAX_CHANGE_PERCENT)
}
