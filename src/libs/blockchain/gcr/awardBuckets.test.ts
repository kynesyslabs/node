import { describe, expect, it } from "bun:test"
import { VALIDATOR_REWARDS_BUCKET, awardBucketRefusal } from "./awardBuckets"
import { applyAwardPoints, applyAwardPointsRollback } from "./gcr_routines/routines/rewardsRoutines"

describe("where an award's points land", () => {
    const date = "2026-11-01T00:00:00.000Z"
    const later = "2026-12-01T00:00:00.000Z"
    const account = () => ({ points: { totalPoints: 0, breakdown: {} as Record<string, unknown> } }) as any
    const edit = (bucket?: string, at = date) => ({ amount: 10, date: at, ...(bucket === undefined ? {} : { bucket }) })

    it("only validatorRewards may be named by an award transaction", () => {
        expect(awardBucketRefusal(undefined)).toBeNull()
        expect(awardBucketRefusal(VALIDATOR_REWARDS_BUCKET)).toBeNull()
        for (const other of ["weeklyChallenge", "referrals", "", null, 1, ["validatorRewards"]]) {
            expect(awardBucketRefusal(other)).not.toBeNull()
        }
    })

    it("a validator award leaves totalPoints and its breakdown untouched", async () => {
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

    it("an award naming no bucket counts as ordinary points only", async () => {
        const a = account()
        await applyAwardPoints(edit(), a)
        expect(a.points.totalPoints).toBe(10)
        expect(a.points.breakdown).toEqual({ weeklyChallenge: [{ date, points: 10 }] })
        expect(a.points.validatorPoints).toBeUndefined()
    })

    it("a rollback takes the points back from the total they were credited to", async () => {
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
