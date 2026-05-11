import { describe, expect, it } from "@jest/globals"
import {
    getBigintBounds,
    GENESIS_NETWORK_PARAMETERS,
    MAX_CHANGE_PERCENT,
    NUMERIC_BOUNDS,
} from "@/features/networkUpgrade/constants"
import { checkSafetyBounds } from "@/features/networkUpgrade/safetyBounds"
import type { NetworkParameters } from "@/features/networkUpgrade/types"

const current: NetworkParameters = { ...GENESIS_NETWORK_PARAMETERS }

describe("safetyBounds — pre-flight (empty / unsupported)", () => {
    it("rejects an empty proposal", () => {
        const r = checkSafetyBounds(current, {})
        expect(r.ok).toBe(false)
    })

    it("rejects a proposal touching a Phase-2 key (blockTimeMs)", () => {
        const r = checkSafetyBounds(current, { blockTimeMs: 2000 })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toContain("not governable in Phase 1")
    })

    it("rejects a proposal touching a Phase-2 key (shardSize)", () => {
        const r = checkSafetyBounds(current, { shardSize: 6 })
        expect(r.ok).toBe(false)
    })

    it("rejects a proposal with a wrong-type value", () => {
        const bad = { networkFee: "50" } as unknown as Partial<NetworkParameters>
        const r = checkSafetyBounds(current, bad)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toMatch(/expected number/)
    })
})

describe("safetyBounds — percentage cap (50%)", () => {
    it("accepts a 50% increase exactly at the cap", () => {
        // current.networkFee=1 (genesis default); use a pinned non-trivial
        // current so the cap math is meaningful (1+1/2=1 with integer division).
        const c: NetworkParameters = { ...current, networkFee: 100 }
        const r = checkSafetyBounds(c, {
            networkFee: c.networkFee + c.networkFee / 2,
        })
        expect(r.ok).toBe(true)
    })

    it("rejects a 51% increase (one over the cap)", () => {
        // Use a current value where 51% > cap is computable cleanly.
        const c: NetworkParameters = { ...current, networkFee: 100 }
        const r = checkSafetyBounds(c, { networkFee: 151 })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toContain(`${MAX_CHANGE_PERCENT}% change`)
    })

    it("accepts a 50% decrease exactly at the cap", () => {
        const c: NetworkParameters = { ...current, networkFee: 100 }
        const r = checkSafetyBounds(c, { networkFee: 50 })
        expect(r.ok).toBe(true)
    })

    it("rejects a 51% decrease (one over the cap)", () => {
        const c: NetworkParameters = { ...current, networkFee: 100 }
        const r = checkSafetyBounds(c, { networkFee: 49 })
        expect(r.ok).toBe(false)
    })

    it("accepts non-negative changes from a 0 baseline (G-3: prevents zero-freeze)", () => {
        // Percent cap is undefined when current=0; the absolute
        // floor/ceiling per key still apply. Without this, an operator
        // that set NETWORK_FEE=0 via env could never raise it via
        // governance.
        const c: NetworkParameters = { ...current, networkFee: 0 }
        const r = checkSafetyBounds(c, { networkFee: 1 })
        expect(r.ok).toBe(true)
    })

    it("still enforces absolute ceiling when current=0", () => {
        const c: NetworkParameters = { ...current, networkFee: 0 }
        const r = checkSafetyBounds(c, {
            networkFee: NUMERIC_BOUNDS.networkFee!.ceiling + 1,
        })
        expect(r.ok).toBe(false)
    })

    it("accepts a 0-to-0 no-op (vacuously within 50% of 0)", () => {
        const c: NetworkParameters = { ...current, networkFee: 0 }
        const r = checkSafetyBounds(c, { networkFee: 0 })
        expect(r.ok).toBe(true)
    })
})

describe("safetyBounds — absolute floors/ceilings (numeric)", () => {
    it("rejects a proposal that hits the absolute ceiling on networkFee", () => {
        const c: NetworkParameters = { ...current, networkFee: 4000 }
        const r = checkSafetyBounds(c, {
            networkFee: NUMERIC_BOUNDS.networkFee!.ceiling + 1,
        })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toContain("ceiling")
    })

    it("rejects a proposal below the absolute floor on networkFee", () => {
        const c: NetworkParameters = { ...current, networkFee: 10 }
        const r = checkSafetyBounds(c, {
            networkFee: NUMERIC_BOUNDS.networkFee!.floor - 1,
        })
        expect(r.ok).toBe(false)
    })
})

describe("safetyBounds — bigint bounds (minValidatorStake)", () => {
    const floor = getBigintBounds().minValidatorStake!.floor

    it("accepts a stake increase of 50% exactly", () => {
        // current = "10_000_000..." — +50% is still in range.
        const c = BigInt(current.minValidatorStake)
        const proposed = (c + c / 2n).toString()
        const r = checkSafetyBounds(current, { minValidatorStake: proposed })
        expect(r.ok).toBe(true)
    })

    it("rejects a proposed stake below the floor", () => {
        const belowFloor = (BigInt(floor) - 1n).toString()
        // Use a current value close enough to pass percent cap.
        const c: NetworkParameters = {
            ...current,
            minValidatorStake: floor,
        }
        const r = checkSafetyBounds(c, { minValidatorStake: belowFloor })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toContain("floor")
    })

    it("rejects a non-numeric bigint string", () => {
        const r = checkSafetyBounds(current, {
            minValidatorStake: "not-a-number",
        })
        expect(r.ok).toBe(false)
    })

    it("rejects a stake that jumps more than 50%", () => {
        const c = BigInt(current.minValidatorStake)
        const proposed = (c * 2n).toString() // +100%
        const r = checkSafetyBounds(current, { minValidatorStake: proposed })
        expect(r.ok).toBe(false)
    })
})

describe("safetyBounds — featureFlags", () => {
    it("accepts a valid flag toggle", () => {
        const r = checkSafetyBounds(current, {
            featureFlags: { l2ps: false },
        })
        expect(r.ok).toBe(true)
    })

    it("rejects a flag with a non-boolean value", () => {
        const r = checkSafetyBounds(current, {
            featureFlags: { l2ps: "off" } as unknown as Record<string, boolean>,
        })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toContain("must be boolean")
    })

    it("rejects a null featureFlags object", () => {
        const r = checkSafetyBounds(current, {
            featureFlags: null as unknown as Record<string, boolean>,
        })
        expect(r.ok).toBe(false)
    })
})

describe("safetyBounds — multi-key proposals", () => {
    it("rejects if any key fails", () => {
        // Pin networkFee=100 so a +1 proposal is well within the 50% cap;
        // the genesis default of 1 makes networkFee+1 a 100% jump that
        // would shadow the minValidatorStake floor failure we want to
        // assert here.
        const c: NetworkParameters = { ...current, networkFee: 100 }
        const r = checkSafetyBounds(c, {
            networkFee: c.networkFee + 1, // good
            minValidatorStake: "0", // below floor
        })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.key).toBe("minValidatorStake")
    })

    it("accepts multiple simultaneous in-bounds changes", () => {
        const c: NetworkParameters = { ...current, networkFee: 100, rpcFee: 10 }
        const s = BigInt(c.minValidatorStake)
        const r = checkSafetyBounds(c, {
            networkFee: 125, // +25%
            minValidatorStake: (s + s / 4n).toString(), // +25%
            featureFlags: { newFlag: true },
        })
        expect(r.ok).toBe(true)
    })
})

// =========================================================================
// DEM-665 — distribution-percentage governance bounds.
// =========================================================================
//
// Three layers under test:
//   1. PHASE_1_GOVERNABLE_KEYS contains the new keys (additionalFee +
//      every distribution percentage).
//   2. NUMERIC_BOUNDS pins each *Pct field to [0, 100].
//   3. Tighter per-proposal cap (DISTRIBUTION_MAX_CHANGE_PERCENT = 10%)
//      applies to distribution keys.
//   4. Cross-key sum-100 invariant on the merged (current ⊕ proposed)
//      view of each distribution group.

describe("safetyBounds — DEM-665 distribution-percentage governance", () => {
    it("accepts additionalFee within bounds", () => {
        const c: NetworkParameters = { ...current, additionalFee: 100 }
        const r = checkSafetyBounds(c, { additionalFee: 110 }) // +10%
        expect(r.ok).toBe(true)
    })

    it("rejects additionalFee above ceiling (5000)", () => {
        const c: NetworkParameters = { ...current, additionalFee: 5000 }
        const r = checkSafetyBounds(c, { additionalFee: 5001 })
        expect(r.ok).toBe(false)
    })

    it("rejects a single-key distribution proposal that breaks sum-100", () => {
        // Touch only networkFeeBurnPct — sibling stays at 50, sum becomes
        // 55+50=105, fails sum invariant.
        const r = checkSafetyBounds(current, { networkFeeBurnPct: 55 })
        expect(r.ok).toBe(false)
        if (!r.ok) {
            expect(r.reason).toMatch(/network_fee/)
            expect(r.reason).toMatch(/sum/)
        }
    })

    it("accepts a balanced two-key network_fee shift within 10% cap", () => {
        // 50→55 burn, 50→45 treasury: sum=100, each delta=5 (10% of 50).
        const r = checkSafetyBounds(current, {
            networkFeeBurnPct: 55,
            networkFeeTreasuryPct: 45,
        })
        expect(r.ok).toBe(true)
    })

    it("rejects a balanced two-key shift exceeding the 10% distribution cap", () => {
        // 50→56 (12% jump) breaks DISTRIBUTION_MAX_CHANGE_PERCENT even
        // though the sum still equals 100.
        const r = checkSafetyBounds(current, {
            networkFeeBurnPct: 56,
            networkFeeTreasuryPct: 44,
        })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toMatch(/10% change/)
    })

    it("rejects a *Pct value above 100", () => {
        const c: NetworkParameters = {
            ...current,
            networkFeeBurnPct: 90,
            networkFeeTreasuryPct: 10,
        }
        const r = checkSafetyBounds(c, { networkFeeBurnPct: 101 })
        expect(r.ok).toBe(false)
    })

    it("validates a balanced three-key special_ops rebalance", () => {
        // Start at 25/25/50; shift to 25/27/48 (each delta ≤ 10% relative
        // to the larger pre-value 50).
        const r = checkSafetyBounds(current, {
            specialOpsBurnPct: 25,
            specialOpsTreasuryPct: 27,
            specialOpsRpcPct: 48,
        })
        expect(r.ok).toBe(true)
    })

    it("rejects a special_ops rebalance whose merged sum != 100", () => {
        const r = checkSafetyBounds(current, {
            specialOpsBurnPct: 25,
            specialOpsTreasuryPct: 26,
            specialOpsRpcPct: 48, // sum = 99
        })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toMatch(/special_ops/)
    })

    it("ignores groups that the proposal does not touch", () => {
        // additional_fee group untouched — sum invariant must NOT fire
        // even though the network_fee group changed.
        const r = checkSafetyBounds(current, {
            networkFeeBurnPct: 55,
            networkFeeTreasuryPct: 45,
        })
        expect(r.ok).toBe(true)
    })
})
