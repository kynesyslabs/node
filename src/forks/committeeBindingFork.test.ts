/**
 * The `committeeBinding` fork ships dormant: until a height is pinned, the
 * committee stays liveness-filtered and sync counts any pool signer. A launch
 * genesis sets it to 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import devnetGenesis from "../../testing/devnet/genesis.devnet.json"

describe("committeeBinding fork config", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is inactive by default and at every height", () => {
        expect(DEFAULT_FORK_CONFIG.committeeBinding.activationHeight).toBeNull()
        expect(isForkActive("committeeBinding", 0)).toBe(false)
        expect(isForkActive("committeeBinding", 1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.committeeBinding.activationHeight = 5
        expect(cloneDefaultForkConfig().committeeBinding.activationHeight).toBeNull()
    })

    it("activates at a genesis height of 0 from the first block", () => {
        loadForkConfigFromGenesis({ forks: { committeeBinding: { activationHeight: 0 } } })
        expect(isForkActive("committeeBinding", 0)).toBe(true)
    })

    it("activates only from a pinned height", () => {
        loadForkConfigFromGenesis({ forks: { committeeBinding: { activationHeight: 100 } } })
        expect(isForkActive("committeeBinding", 99)).toBe(false)
        expect(isForkActive("committeeBinding", 100)).toBe(true)
    })

    it("stays inactive when genesis does not mention it", () => {
        loadForkConfigFromGenesis({ forks: { quorumParity: { activationHeight: 0 } } })
        expect(isForkActive("committeeBinding", 1_000)).toBe(false)
    })

    it("is active from block 0 on the devnet genesis, like quorumParity", () => {
        loadForkConfigFromGenesis(devnetGenesis)
        expect(isForkActive("quorumParity", 0)).toBe(true)
        expect(isForkActive("committeeBinding", 0)).toBe(true)
    })
})
