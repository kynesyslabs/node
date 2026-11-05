/**
 * The `finalityProofs` fork ships dormant: until a height is pinned, block
 * content carries no finality commitments and hashes exactly as before. A
 * launch genesis sets it to 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import devnetGenesis from "../../testing/devnet/genesis.devnet.json"

describe("finalityProofs fork config", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is inactive by default and at every height", () => {
        expect(DEFAULT_FORK_CONFIG.finalityProofs.activationHeight).toBeNull()
        expect(isForkActive("finalityProofs", 0)).toBe(false)
        expect(isForkActive("finalityProofs", 1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.finalityProofs.activationHeight = 5
        expect(cloneDefaultForkConfig().finalityProofs.activationHeight).toBeNull()
        expect(a.finalityProofs).not.toBe(DEFAULT_FORK_CONFIG.finalityProofs)
    })

    it("activates at a genesis height of 0 from the first block", () => {
        loadForkConfigFromGenesis({ forks: { finalityProofs: { activationHeight: 0 } } })
        expect(isForkActive("finalityProofs", 0)).toBe(true)
    })

    it("activates only from a pinned height", () => {
        loadForkConfigFromGenesis({ forks: { finalityProofs: { activationHeight: 100 } } })
        expect(isForkActive("finalityProofs", 99)).toBe(false)
        expect(isForkActive("finalityProofs", 100)).toBe(true)
    })

    it("stays inactive when genesis does not mention it", () => {
        loadForkConfigFromGenesis({ forks: { committeeBinding: { activationHeight: 0 } } })
        expect(isForkActive("finalityProofs", 1_000)).toBe(false)
    })

    it("refuses a malformed activation height", () => {
        for (const activationHeight of [-1, 1.5, "0"]) {
            expect(() =>
                loadForkConfigFromGenesis({ forks: { finalityProofs: { activationHeight } } }),
            ).toThrow(ForkConfigValidationError)
        }
    })

    it("is active from block 0 on the devnet genesis", () => {
        loadForkConfigFromGenesis(devnetGenesis)
        expect(isForkActive("finalityProofs", 0)).toBe(true)
    })

    it("is loadable for every registered fork, so no fork lacks a loader branch", () => {
        for (const name of Object.keys(DEFAULT_FORK_CONFIG) as (keyof ForkConfigByName)[]) {
            getSharedState.forkConfig = cloneDefaultForkConfig()
            const entry: Record<string, unknown> = { activationHeight: null }
            if (name === "gasFeeSeparation") {
                entry.treasuryAddress = DEFAULT_FORK_CONFIG.gasFeeSeparation.treasuryAddress
            }
            loadForkConfigFromGenesis({ forks: { [name]: entry } })
            expect(getSharedState.forkConfig[name].activationHeight).toBeNull()
        }
    })
})
