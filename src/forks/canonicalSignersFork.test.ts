/**
 * The `canonicalSigners` fork ships dormant: until a height is pinned,
 * block signatures count as they always did, and a dormant entry leaves the
 * fork schedule peers compare unchanged. A new chain may schedule it at
 * height 0 explicitly; the mainnet template leaves it dormant until it is
 * scheduled.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { scheduleFromForkConfig } from "src/libs/blockchain/genesis/acceptedForkSchedule"
import { getSharedState } from "@/utilities/sharedState"

describe("canonicalSigners fork config", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is inactive by default and at every height", () => {
        expect(DEFAULT_FORK_CONFIG.canonicalSigners.activationHeight).toBeNull()
        expect(isForkActive("canonicalSigners", 0)).toBe(false)
        expect(isForkActive("canonicalSigners", 1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.canonicalSigners.activationHeight = 5
        expect(cloneDefaultForkConfig().canonicalSigners.activationHeight).toBeNull()
    })

    it("activates only from a pinned height", () => {
        loadForkConfigFromGenesis({ forks: { canonicalSigners: { activationHeight: 100 } } })
        expect(isForkActive("canonicalSigners", 99)).toBe(false)
        expect(isForkActive("canonicalSigners", 100)).toBe(true)
    })

    it("stays out of the fork schedule while dormant", () => {
        const forks = scheduleFromForkConfig(cloneDefaultForkConfig() as any, null).forks
        expect(Object.keys(forks)).not.toContain("canonicalSigners")
    })
})
