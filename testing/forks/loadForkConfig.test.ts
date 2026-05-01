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
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
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

    it("treats non-numeric activationHeight as null (defensive)", () => {
        loadForkConfigFromGenesis({
            forks: {
                osDenomination: {
                    activationHeight: "not-a-number",
                },
            },
        })
        expect(
            getSharedState.forkConfig.osDenomination.activationHeight,
        ).toBeNull()
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
