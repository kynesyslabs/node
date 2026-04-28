import { describe, expect, it } from "@jest/globals"
import {
    BIGINT_BOUNDS,
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
        const r = checkSafetyBounds(current, {
            networkFee: current.networkFee + current.networkFee / 2,
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

    it("rejects any change from a 0 baseline (unbounded-growth)", () => {
        const c: NetworkParameters = { ...current, networkFee: 0 }
        const r = checkSafetyBounds(c, { networkFee: 1 })
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
    const floor = BIGINT_BOUNDS.minValidatorStake!.floor

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
        const r = checkSafetyBounds(current, {
            networkFee: current.networkFee + 1, // good
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
