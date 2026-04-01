import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import { safeGCRSave } from "./utils"

export async function applyAwardPoints(
    editOperation: any,
    accountGCR: GCRMain,
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

    return { success: true, message: "Points awarded", entity: accountGCR }
}

export async function applyAwardPointsRollback(
    editOperation: any,
    account: GCRMain,
): Promise<GCRResult> {
    const { account: address, amount, date } = editOperation

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

    return { success: true, message: "Points deducted", entity: account }
}
