/**
 * The `editBinding` fork ships dormant: until a height is pinned, apply is
 * what it was. A launch genesis that wants the rule from block 0 sets it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"

describe("editBinding fork config", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is inactive by default and at every height", () => {
        expect(DEFAULT_FORK_CONFIG.editBinding.activationHeight).toBeNull()
        expect(cloneDefaultForkConfig().editBinding.activationHeight).toBeNull()
        expect(isForkActive("editBinding", 0)).toBe(false)
        expect(isForkActive("editBinding", 1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.editBinding.activationHeight = 5
        expect(cloneDefaultForkConfig().editBinding.activationHeight).toBeNull()
        expect(DEFAULT_FORK_CONFIG.editBinding.activationHeight).toBeNull()
    })

    it("does not disturb the forks that default to height 0", () => {
        expect(DEFAULT_FORK_CONFIG.osDenomination.activationHeight).toBe(0)
        expect(DEFAULT_FORK_CONFIG.nonceEnforcement.activationHeight).toBe(0)
        expect(DEFAULT_FORK_CONFIG.gasFeeSeparation.activationHeight).toBe(0)
    })

    it("activates at a genesis height of 0 from the first block", () => {
        loadForkConfigFromGenesis({ forks: { editBinding: { activationHeight: 0 } } })
        expect(getSharedState.forkConfig.editBinding.activationHeight).toBe(0)
        expect(isForkActive("editBinding", 0)).toBe(true)
    })

    it("activates only from a pinned height", () => {
        loadForkConfigFromGenesis({ forks: { editBinding: { activationHeight: 100 } } })
        expect(isForkActive("editBinding", 99)).toBe(false)
        expect(isForkActive("editBinding", 100)).toBe(true)
    })

    it("stays inactive when genesis does not mention it", () => {
        loadForkConfigFromGenesis({ forks: { osDenomination: { activationHeight: 0 } } })
        expect(isForkActive("editBinding", 1_000)).toBe(false)
    })

    it("refuses a malformed height rather than reading it as inactive", () => {
        expect(() => loadForkConfigFromGenesis({ forks: { editBinding: { activationHeight: -1 } } })).toThrow(ForkConfigValidationError)
        expect(() => loadForkConfigFromGenesis({ forks: { editBinding: { activationHeight: "soon" } } })).toThrow(ForkConfigValidationError)
    })
})
