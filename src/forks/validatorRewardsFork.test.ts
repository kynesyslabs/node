/**
 * The `validatorRewards` fork ships dormant: a running chain credits every
 * award to the account's ordinary points until a height is agreed. A launch
 * genesis sets it to 0, so mainnet keeps validator points apart from block 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { isForkActive } from "@/forks/forkGates"
import { DEFAULT_FORK_CONFIG, cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { VALIDATOR_REWARDS_BUCKET, awardBucketRefusal } from "@/forks/validatorRewardsGate"
import { applyAwardPoints, applyAwardPointsRollback } from "@/libs/blockchain/gcr/gcr_routines/routines/rewardsRoutines"
import { getSharedState } from "@/utilities/sharedState"
import { MAINNET_FORKS } from "../../scripts/launch-go-no-go"

describe("validatorRewards fork config", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("is inactive by default and at every height", () => {
        expect(DEFAULT_FORK_CONFIG.validatorRewards.activationHeight).toBeNull()
        expect(isForkActive("validatorRewards", 0)).toBe(false)
        expect(isForkActive("validatorRewards", 1_000_000)).toBe(false)
    })

    it("is copied, not shared, by the default clone", () => {
        const a = cloneDefaultForkConfig()
        a.validatorRewards.activationHeight = 5
        expect(cloneDefaultForkConfig().validatorRewards.activationHeight).toBeNull()
    })

    it("activates from a genesis height", () => {
        loadForkConfigFromGenesis({ forks: { validatorRewards: { activationHeight: 100 } } })
        expect(isForkActive("validatorRewards", 99)).toBe(false)
        expect(isForkActive("validatorRewards", 100)).toBe(true)
    })

    it("stays inactive on the testnet genesis, which does not mention it", () => {
        loadForkConfigFromGenesis(JSON.parse(readFileSync("data/genesis.json", "utf8")))
        expect(isForkActive("validatorRewards", 1_000_000)).toBe(false)
    })

    it("refuses a malformed activation height", () => {
        for (const activationHeight of [-1, 1.5, "0"]) {
            expect(() =>
                loadForkConfigFromGenesis({ forks: { validatorRewards: { activationHeight } } }),
            ).toThrow(ForkConfigValidationError)
        }
    })

    it("is required at block 0 in the mainnet genesis and set there by the template", () => {
        expect(MAINNET_FORKS).toContain("validatorRewards")
        const template = JSON.parse(readFileSync("docs/mainnet/genesis.template.json", "utf8"))
        expect(template.forks.validatorRewards).toEqual({ activationHeight: 0 })
    })
})

describe("where an award's points land", () => {
    let snapshot: ForkConfigByName
    const date = "2026-11-01T00:00:00.000Z"
    const later = "2026-12-01T00:00:00.000Z"
    const account = () => ({ points: { totalPoints: 0, breakdown: {} as Record<string, unknown> } }) as any
    const edit = (bucket?: string, at = date) => ({ amount: 10, date: at, ...(bucket === undefined ? {} : { bucket }) })

    beforeEach(() => {
        snapshot = getSharedState.forkConfig
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    it("a bucket is refused by name before the fork, and only validatorRewards is accepted under it", () => {
        expect(awardBucketRefusal(undefined)).toBeNull()
        expect(awardBucketRefusal(VALIDATOR_REWARDS_BUCKET)).not.toBeNull()
        getSharedState.forkConfig.validatorRewards.activationHeight = 0
        expect(awardBucketRefusal(undefined)).toBeNull()
        expect(awardBucketRefusal(VALIDATOR_REWARDS_BUCKET)).toBeNull()
        for (const other of ["weeklyChallenge", "referrals", "", null, 1, ["validatorRewards"]]) {
            expect(awardBucketRefusal(other)).not.toBeNull()
        }
    })

    it("before the fork every award counts as ordinary points, whatever the edit names", async () => {
        const a = account()
        await applyAwardPoints(edit(VALIDATOR_REWARDS_BUCKET), a)
        expect(a.points.breakdown).toEqual({ weeklyChallenge: [{ date, points: 10 }] })
        expect(a.points.totalPoints).toBe(10)
        expect(a.points.validatorPoints).toBeUndefined()
    })

    it("under the fork a validator award leaves totalPoints and its breakdown untouched", async () => {
        getSharedState.forkConfig.validatorRewards.activationHeight = 0
        const a = account()
        await applyAwardPoints(edit(VALIDATOR_REWARDS_BUCKET), a)
        await applyAwardPoints(edit(VALIDATOR_REWARDS_BUCKET, later), a)
        expect(a.points.validatorPoints).toEqual({
            total: 20,
            awards: [{ date, points: 10 }, { date: later, points: 10 }],
        })
        expect(a.points.totalPoints).toBe(0)
        expect(a.points.breakdown).toEqual({})
    })

    it("under the fork an award naming no bucket still counts as ordinary points only", async () => {
        getSharedState.forkConfig.validatorRewards.activationHeight = 0
        const a = account()
        await applyAwardPoints(edit(), a)
        expect(a.points.totalPoints).toBe(10)
        expect(a.points.breakdown).toEqual({ weeklyChallenge: [{ date, points: 10 }] })
        expect(a.points.validatorPoints).toBeUndefined()
    })

    it("a rollback takes the points back from the total they were credited to", async () => {
        getSharedState.forkConfig.validatorRewards.activationHeight = 0
        const a = account()
        await applyAwardPoints(edit(VALIDATOR_REWARDS_BUCKET), a)
        await applyAwardPoints(edit(VALIDATOR_REWARDS_BUCKET, later), a)
        await applyAwardPoints(edit(), a)

        await applyAwardPointsRollback(edit(VALIDATOR_REWARDS_BUCKET), a)
        expect(a.points.validatorPoints).toEqual({ total: 10, awards: [{ date: later, points: 10 }] })
        expect(a.points.totalPoints).toBe(10)

        await applyAwardPointsRollback(edit(), a)
        expect(a.points.totalPoints).toBe(0)
        expect(a.points.breakdown).toEqual({ weeklyChallenge: [] })
        expect(a.points.validatorPoints.total).toBe(10)
    })
})
