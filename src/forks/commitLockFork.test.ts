/**
 * The `commitLock` fork ships dormant. A genesis may schedule it only
 * together with committeeBinding: the lock's quorums overlap only inside one
 * bound committee.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import devnetGenesis from "../../testing/devnet/genesis.devnet.json"

describe("commitLock fork config", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is inactive by default and at every height", () => {
        expect(DEFAULT_FORK_CONFIG.commitLock.activationHeight).toBeNull()
        expect(isForkActive("commitLock", 0)).toBe(false)
        expect(isForkActive("commitLock", 1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.commitLock.activationHeight = 5
        expect(cloneDefaultForkConfig().commitLock.activationHeight).toBeNull()
    })

    it("activates with committeeBinding at a genesis height of 0", () => {
        loadForkConfigFromGenesis({
            forks: {
                committeeBinding: { activationHeight: 0 },
                commitLock: { activationHeight: 0 },
            },
        })
        expect(isForkActive("commitLock", 0)).toBe(true)
    })

    it("activates only from a pinned height", () => {
        loadForkConfigFromGenesis({
            forks: {
                committeeBinding: { activationHeight: 0 },
                commitLock: { activationHeight: 100 },
            },
        })
        expect(isForkActive("commitLock", 99)).toBe(false)
        expect(isForkActive("commitLock", 100)).toBe(true)
    })

    it("stays inactive when genesis does not mention it", () => {
        loadForkConfigFromGenesis({ forks: { committeeBinding: { activationHeight: 0 } } })
        expect(isForkActive("commitLock", 1_000)).toBe(false)
    })

    it("refuses a genesis that schedules it without committeeBinding", () => {
        expect(() =>
            loadForkConfigFromGenesis({ forks: { commitLock: { activationHeight: 0 } } }),
        ).toThrow(ForkConfigValidationError)
    })

    it("refuses a genesis that schedules it before committeeBinding", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    committeeBinding: { activationHeight: 50 },
                    commitLock: { activationHeight: 10 },
                },
            }),
        ).toThrow(ForkConfigValidationError)
    })

    it("refuses a malformed activation height", () => {
        expect(() =>
            loadForkConfigFromGenesis({
                forks: {
                    committeeBinding: { activationHeight: 0 },
                    commitLock: { activationHeight: -1 },
                },
            }),
        ).toThrow(ForkConfigValidationError)
    })

    it("is active from block 0 on the devnet genesis, with committeeBinding", () => {
        loadForkConfigFromGenesis(devnetGenesis)
        expect(isForkActive("committeeBinding", 0)).toBe(true)
        expect(isForkActive("commitLock", 0)).toBe(true)
    })
})
