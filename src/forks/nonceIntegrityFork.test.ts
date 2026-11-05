/**
 * The `nonceIntegrity` fork ships dormant: until a height is pinned, apply and
 * admission are what they were. A launch genesis that wants the rule from
 * block 0 sets it, and the devnet genesis does.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"

describe("nonceIntegrity fork config", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is inactive by default and at every height", () => {
        expect(DEFAULT_FORK_CONFIG.nonceIntegrity.activationHeight).toBeNull()
        expect(cloneDefaultForkConfig().nonceIntegrity.activationHeight).toBeNull()
        expect(isForkActive("nonceIntegrity", 0)).toBe(false)
        expect(isForkActive("nonceIntegrity", 1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.nonceIntegrity.activationHeight = 5
        expect(cloneDefaultForkConfig().nonceIntegrity.activationHeight).toBeNull()
        expect(DEFAULT_FORK_CONFIG.nonceIntegrity.activationHeight).toBeNull()
    })

    it("activates at a genesis height of 0 from the first block", () => {
        loadForkConfigFromGenesis({ forks: { nonceIntegrity: { activationHeight: 0 } } })
        expect(getSharedState.forkConfig.nonceIntegrity.activationHeight).toBe(0)
        expect(isForkActive("nonceIntegrity", 0)).toBe(true)
    })

    it("activates only from a pinned height", () => {
        loadForkConfigFromGenesis({ forks: { nonceIntegrity: { activationHeight: 100 } } })
        expect(isForkActive("nonceIntegrity", 99)).toBe(false)
        expect(isForkActive("nonceIntegrity", 100)).toBe(true)
    })

    it("stays inactive when genesis does not mention it", () => {
        loadForkConfigFromGenesis({ forks: { editBinding: { activationHeight: 0 } } })
        expect(isForkActive("nonceIntegrity", 1_000)).toBe(false)
    })

    it("refuses a malformed height rather than reading it as inactive", () => {
        expect(() => loadForkConfigFromGenesis({ forks: { nonceIntegrity: { activationHeight: -1 } } })).toThrow(ForkConfigValidationError)
        expect(() => loadForkConfigFromGenesis({ forks: { nonceIntegrity: { activationHeight: "soon" } } })).toThrow(ForkConfigValidationError)
    })

    it("is on from block 0 in the devnet genesis", () => {
        const genesis = JSON.parse(readFileSync("testing/devnet/genesis.devnet.json", "utf8"))
        expect(genesis.forks.nonceIntegrity).toEqual({ activationHeight: 0 })
    })
})
