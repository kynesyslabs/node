/**
 * Tests for the genesis fork-config loader.
 *
 * The loader must:
 *  - Be a no-op when the genesis payload has no `forks` field (default
 *    case in production today; confirms bit-identical to pre-P2).
 *  - Hydrate known fork names with their declared `activationHeight`.
 *  - Ignore unknown fork names defensively (logs a warning, no throw).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
    ForkConfigValidationError,
    loadForkConfigFromGenesis,
} from "@/forks/loadForkConfig"
import {
    cloneDefaultForkConfig,
    type ForkConfig,
    type ForkName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

describe("loadForkConfigFromGenesis", () => {
    let snapshot: Record<ForkName, ForkConfig>

    beforeEach(() => {
        snapshot = cloneDefaultForkConfig()
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is a no-op for genesis with no `forks` field", () => {
        const before = JSON.stringify(getSharedState.forkConfig)
        loadForkConfigFromGenesis({
            properties: { id: 1, name: "DEMOS", currency: "DEM" },
            balances: [],
        })
        const after = JSON.stringify(getSharedState.forkConfig)
        expect(after).toBe(before)
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBeNull()
    })

    it("hydrates osDenomination activation height when present", () => {
        loadForkConfigFromGenesis({
            forks: {
                osDenomination: {
                    activationHeight: 12345,
                    description: "test",
                },
            },
        })
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBe(12345)
    })

    // myc#81 / GH#3213220458: malformed activationHeight throws rather
    // than silently coercing to null. Silent coerce would turn a
    // misconfigured genesis into a consensus-time surprise; the loader
    // is the right place to refuse to boot.
    it("throws on string activationHeight", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    osDenomination: { activationHeight: "not-a-number" },
                },
            }),
        ).toThrow(/non-negative integer or null/)
    })

    // GH#3214986124 (Greptile P1): the throw must be a discriminable
    // ForkConfigValidationError so the boot-time catch in
    // findGenesisBlock can re-throw it (refusing to boot) while still
    // warning-and-continuing on benign IO/parse errors.
    it("throws ForkConfigValidationError (not generic Error) on validation failure", () => {
        let caught: unknown = null
        try {
            loadForkConfigFromGenesis({
                forks: {
                    osDenomination: { activationHeight: "200" },
                },
            })
        } catch (e) {
            caught = e
        }
        expect(caught).toBeInstanceOf(ForkConfigValidationError)
    })

    it("throws on negative activationHeight", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    osDenomination: { activationHeight: -1 },
                },
            }),
        ).toThrow(/non-negative integer or null/)
    })

    it("throws on fractional activationHeight", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    osDenomination: { activationHeight: 12.5 },
                },
            }),
        ).toThrow(/non-negative integer or null/)
    })

    it("throws on NaN activationHeight", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    osDenomination: { activationHeight: Number.NaN },
                },
            }),
        ).toThrow(/non-negative integer or null/)
    })

    it("throws on Infinity activationHeight", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    osDenomination: {
                        activationHeight: Number.POSITIVE_INFINITY,
                    },
                },
            }),
        ).toThrow(/non-negative integer or null/)
    })

    it("throws on undefined-not-null activationHeight", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    osDenomination: { activationHeight: undefined },
                },
            }),
        ).toThrow(/non-negative integer or null/)
    })

    it("throws when fork entry is not an object", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    osDenomination: "active",
                },
            }),
        ).toThrow(/must be an object/)
    })

    it("accepts null activationHeight (configured but inactive)", () => {
        loadForkConfigFromGenesis({
            forks: {
                osDenomination: { activationHeight: null },
            },
        })
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBeNull()
    })

    it("accepts a valid non-negative integer (boundary: 0)", () => {
        loadForkConfigFromGenesis({
            forks: {
                osDenomination: { activationHeight: 0 },
            },
        })
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBe(0)
    })

    it("ignores prototype-walking lookup attempts (e.g. __proto__)", () => {
        // Object.hasOwn must reject inherited keys so a genesis cannot
        // smuggle a write into Object.prototype keys.
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    __proto__: { activationHeight: 1 },
                    osDenomination: { activationHeight: 999 },
                },
            }),
        ).not.toThrow()
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBe(999)
        // The prototype's activationHeight must remain untouched.
        expect(
            (Object.prototype as unknown as { activationHeight?: unknown })
                .activationHeight,
        ).toBeUndefined()
    })

    it("drops a non-string description but does not throw", () => {
        loadForkConfigFromGenesis({
            forks: {
                osDenomination: {
                    activationHeight: 5,
                    description: 42,
                },
            },
        })
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBe(5)
        expect(
            getSharedState.forkConfig.osDenomination.description,
        ).toBeUndefined()
    })

    it("ignores unknown fork names without throwing", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    futureFork: { activationHeight: 1 },
                    osDenomination: { activationHeight: 999 },
                },
            }),
        ).not.toThrow()
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBe(999)
        // Unknown fork should not have been added to the registry.
        expect(
            (getSharedState.forkConfig as any).futureFork,
        ).toBeUndefined()
    })

    it("handles null/undefined/non-object input gracefully", () => {
        expect(() => loadForkConfigFromGenesis(null)).not.toThrow()
        expect(() => loadForkConfigFromGenesis(undefined)).not.toThrow()
        expect(() => loadForkConfigFromGenesis("not-an-object")).not.toThrow()
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBeNull()
    })
})
