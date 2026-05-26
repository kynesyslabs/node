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
    GAS_FEE_SEPARATION_BURN_ADDRESS,
    loadForkConfigFromGenesis,
} from "@/forks/loadForkConfig"
import {
    cloneDefaultForkConfig,
    PLACEHOLDER_TREASURY_ADDRESS,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"

const VALID_TREASURY = "0x" + "ab".repeat(32)

describe("loadForkConfigFromGenesis", () => {
    let snapshot: ForkConfigByName
    let feeDistSnapshot: typeof getSharedState.feeDistribution

    beforeEach(() => {
        snapshot = cloneDefaultForkConfig()
        feeDistSnapshot = getSharedState.feeDistribution
        getSharedState.forkConfig = cloneDefaultForkConfig()
        getSharedState.feeDistribution = null
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
        getSharedState.feeDistribution = feeDistSnapshot
    })

    it("is a no-op for genesis with no `forks` field", () => {
        // Pin to a known sentinel so we can prove no-op: any value
        // other than the library default would be overwritten if the
        // loader were active.
        getSharedState.forkConfig.osDenomination.activationHeight = null
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
        // Pin to null so the assertion below proves the loader was a
        // pure no-op (rather than matching the new post-fork default).
        getSharedState.forkConfig.osDenomination.activationHeight = null
        expect(() => loadForkConfigFromGenesis(null)).not.toThrow()
        expect(() => loadForkConfigFromGenesis(undefined)).not.toThrow()
        expect(() => loadForkConfigFromGenesis("not-an-object")).not.toThrow()
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBeNull()
    })

    // ------------------------------------------------------------------
    // DEM-665 — gasFeeSeparation fork payload validation.
    // ------------------------------------------------------------------

    it("hydrates gasFeeSeparation with treasuryAddress + activationHeight", () => {
        loadForkConfigFromGenesis({
            forks: {
                gasFeeSeparation: {
                    activationHeight: 5000,
                    treasuryAddress: VALID_TREASURY,
                },
            },
        })
        const gfs = getSharedState.forkConfig.gasFeeSeparation
        expect(gfs.activationHeight).toBe(5000)
        expect(gfs.treasuryAddress).toBe(VALID_TREASURY)
    })

    it("primes feeDistribution.burnAddress and treasuryAddress from fork payload", () => {
        loadForkConfigFromGenesis({
            forks: {
                gasFeeSeparation: {
                    activationHeight: 5000,
                    treasuryAddress: VALID_TREASURY,
                },
            },
        })
        const fd = getSharedState.feeDistribution
        expect(fd).not.toBeNull()
        expect(fd!.burnAddress).toBe(GAS_FEE_SEPARATION_BURN_ADDRESS)
        expect(fd!.treasuryAddress).toBe(VALID_TREASURY)
    })

    it("primes feeDistribution even when genesis has no forks block", () => {
        loadForkConfigFromGenesis({
            properties: { id: 1, name: "DEMOS", currency: "DEM" },
            balances: [],
        })
        const fd = getSharedState.feeDistribution
        expect(fd).not.toBeNull()
        expect(fd!.burnAddress).toBe(GAS_FEE_SEPARATION_BURN_ADDRESS)
        // Placeholder treasury comes from the default fork config; the
        // loader does not reject the placeholder until activationHeight
        // is non-null.
        expect(fd!.treasuryAddress).toBe(PLACEHOLDER_TREASURY_ADDRESS)
    })

    it("throws when gasFeeSeparation.treasuryAddress is missing", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    gasFeeSeparation: { activationHeight: 5000 },
                },
            }),
        ).toThrow(/treasuryAddress must be a string/)
    })

    it("throws when gasFeeSeparation.treasuryAddress is not a string", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    gasFeeSeparation: {
                        activationHeight: 5000,
                        treasuryAddress: 12345,
                    },
                },
            }),
        ).toThrow(/treasuryAddress must be a string/)
    })

    it("throws on mixed-case hex treasuryAddress (PR #778 G-1/G-4 lesson)", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    gasFeeSeparation: {
                        activationHeight: 5000,
                        treasuryAddress: "0x" + "Ab".repeat(32),
                    },
                },
            }),
        ).toThrow(/0x \+ 64 hex chars/)
    })

    it("throws on missing 0x prefix in treasuryAddress", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    gasFeeSeparation: {
                        activationHeight: 5000,
                        treasuryAddress: "a".repeat(64),
                    },
                },
            }),
        ).toThrow(/0x \+ 64 hex chars/)
    })

    it("throws on too-short treasuryAddress", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    gasFeeSeparation: {
                        activationHeight: 5000,
                        treasuryAddress: "0xabcd",
                    },
                },
            }),
        ).toThrow(/0x \+ 64 hex chars/)
    })

    it("throws when scheduled fork uses placeholder zero treasury", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    gasFeeSeparation: {
                        activationHeight: 5000,
                        treasuryAddress: GAS_FEE_SEPARATION_BURN_ADDRESS,
                    },
                },
            }),
        ).toThrow(/placeholder zero address but activationHeight=5000/)
    })

    it("accepts placeholder treasury when activationHeight is null (unscheduled)", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    gasFeeSeparation: {
                        activationHeight: null,
                        treasuryAddress: GAS_FEE_SEPARATION_BURN_ADDRESS,
                    },
                },
            }),
        ).not.toThrow()
        expect(
            getSharedState.forkConfig.gasFeeSeparation.treasuryAddress,
        ).toBe(GAS_FEE_SEPARATION_BURN_ADDRESS)
    })

    it("treats validation error on gasFeeSeparation as ForkConfigValidationError", () => {
        let caught: unknown = null
        try {
            loadForkConfigFromGenesis({
                forks: {
                    gasFeeSeparation: {
                        activationHeight: 5000,
                        treasuryAddress: "not-hex",
                    },
                },
            })
        } catch (e) {
            caught = e
        }
        expect(caught).toBeInstanceOf(ForkConfigValidationError)
    })

    it("loads osDenomination and gasFeeSeparation at same activationHeight (combined-fork scenario)", () => {
        loadForkConfigFromGenesis({
            forks: {
                osDenomination: { activationHeight: 5000 },
                gasFeeSeparation: {
                    activationHeight: 5000,
                    treasuryAddress: VALID_TREASURY,
                },
            },
        })
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBe(5000)
        expect(
            getSharedState.forkConfig.gasFeeSeparation.activationHeight,
        ).toBe(5000)
        expect(
            getSharedState.forkConfig.gasFeeSeparation.treasuryAddress,
        ).toBe(VALID_TREASURY)
        expect(getSharedState.feeDistribution!.treasuryAddress).toBe(
            VALID_TREASURY,
        )
    })

    it("primeFeeDistribution preserves prior percentage groups across re-loads", () => {
        // Simulate loadNetworkParameters having folded governance percentages
        // onto feeDistribution before a hypothetical re-load of the fork
        // config (e.g. test harness or mid-session reset).
        getSharedState.feeDistribution = {
            burnAddress: GAS_FEE_SEPARATION_BURN_ADDRESS,
            treasuryAddress: PLACEHOLDER_TREASURY_ADDRESS,
            networkFee: { burnPct: 50, treasuryPct: 50 },
            additionalFee: { burnPct: 25, treasuryPct: 75 },
            specialOps: { burnPct: 25, rpcPct: 50, treasuryPct: 25 },
        }
        loadForkConfigFromGenesis({
            forks: {
                gasFeeSeparation: {
                    activationHeight: 5000,
                    treasuryAddress: VALID_TREASURY,
                },
            },
        })
        const fd = getSharedState.feeDistribution!
        expect(fd.treasuryAddress).toBe(VALID_TREASURY)
        expect(fd.networkFee.burnPct).toBe(50)
        expect(fd.additionalFee.treasuryPct).toBe(75)
        expect(fd.specialOps.rpcPct).toBe(50)
    })
})
