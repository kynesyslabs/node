import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import { safeGCRSave } from "./utils"

export async function applyAwardPoints(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const { account: address, amount, date } = editOperation
    const account = await ensureGCRForUser(address)

    const challengeEntry = {
        date,
        points: amount,
    }

    if (!account.points.breakdown.weeklyChallenge) {
        account.points.breakdown.weeklyChallenge = []
    }

    account.points.breakdown.weeklyChallenge.push(challengeEntry)
    account.points.totalPoints = (account.points.totalPoints || 0) + amount
    account.points.lastUpdated = new Date()

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, account, "applyAwardPoints")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }
    }

    return { success: true, message: "Points awarded" }
}

export async function applyAwardPointsRollback(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const { account: address, amount, date } = editOperation
    const account = await ensureGCRForUser(address)

    if (!account.points.breakdown.weeklyChallenge) {
        account.points.breakdown.weeklyChallenge = []
    }

    account.points.breakdown.weeklyChallenge =
        account.points.breakdown.weeklyChallenge.filter(
            (entry: { date: string }) => entry.date !== date,
        )

    account.points.totalPoints =
        (account.points.totalPoints || 0) - amount < 0
            ? 0
            : account.points.totalPoints - amount

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, account, "applyAwardPointsRollback")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }
    }

    return { success: true, message: "Points deducted" }
}
