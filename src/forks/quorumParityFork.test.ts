/**
 * The `quorumParity` fork ships dormant: until a height is pinned, sync
 * counts the quorum as it always did. A launch genesis sets it to 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"

describe("quorumParity fork config", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is inactive by default and at every height", () => {
        expect(DEFAULT_FORK_CONFIG.quorumParity.activationHeight).toBeNull()
        expect(isForkActive("quorumParity", 0)).toBe(false)
        expect(isForkActive("quorumParity", 1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.quorumParity.activationHeight = 5
        expect(cloneDefaultForkConfig().quorumParity.activationHeight).toBeNull()
    })

    it("activates at a genesis height of 0 from the first block", () => {
        loadForkConfigFromGenesis({ forks: { quorumParity: { activationHeight: 0 } } })
        expect(isForkActive("quorumParity", 0)).toBe(true)
    })

    it("activates only from a pinned height", () => {
        loadForkConfigFromGenesis({ forks: { quorumParity: { activationHeight: 100 } } })
        expect(isForkActive("quorumParity", 99)).toBe(false)
        expect(isForkActive("quorumParity", 100)).toBe(true)
    })

    it("stays inactive when genesis does not mention it", () => {
        loadForkConfigFromGenesis({ forks: { editBinding: { activationHeight: 0 } } })
        expect(isForkActive("quorumParity", 1_000)).toBe(false)
    })
})
