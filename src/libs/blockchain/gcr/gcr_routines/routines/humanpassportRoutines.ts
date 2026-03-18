import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import { SavedHumanPassportIdentity } from "@/model/entities/types/IdentityTypes"
import HumanPassportProvider from "@/libs/identity/tools/humanpassport"
import log from "@/utilities/logger"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection } from "./utils"

export async function applyHumanPassportIdentityAdd(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    try {
        const clientData = editOperation.data as { address: string; verificationMethod: "api" | "onchain" }
        const normalizedAddress = clientData.address.toLowerCase()

        // Fetch verified score from Human Passport API (uses cache from earlier verification)
        const provider = HumanPassportProvider.getInstance()
        const verification = await provider.verifyAddress(normalizedAddress)

        // REVIEW: Guard against score degradation between tx submission and block application
        if (!verification.passingScore) {
            return {
                success: false,
                message: `Human Passport score ${verification.score} no longer meets the required threshold (${verification.threshold})`,
            }
        }

        const savedIdentity: SavedHumanPassportIdentity = {
            address: verification.address,
            score: verification.score,
            passingScore: verification.passingScore,
            threshold: verification.threshold,
            stamps: verification.stamps,
            verificationMethod: clientData.verificationMethod,
            verifiedAt: verification.verifiedAt,
            expiresAt: verification.expirationTimestamp
                ? new Date(verification.expirationTimestamp).getTime()
                : null,
        }

        const accountGCR = await ensureGCRForUser(editOperation.account)

        // Initialize humanpassport array if needed
        if (!accountGCR.identities.humanpassport) {
            accountGCR.identities.humanpassport = []
        }

        // Global uniqueness check across all accounts
        const isFirst = await isFirstConnection(
            "humanpassport",
            { address: normalizedAddress },
            gcrMainRepository,
            editOperation.account,
        )

        // Upsert: remove existing then add new
        accountGCR.identities.humanpassport =
            accountGCR.identities.humanpassport.filter(
                (hp: SavedHumanPassportIdentity) =>
                    hp.address.toLowerCase() !== normalizedAddress,
            )
        accountGCR.identities.humanpassport.push(savedIdentity)

        if (!simulate) {
            const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyHumanPassportIdentityAdd")
            if (!saveResult.success) {
                return { success: false, message: saveResult.error || "Database save failed" }
            }

            if (isFirst) {
                await IncentiveManager.humanPassportLinked(
                    accountGCR.pubkey,
                    editOperation.referralCode,
                )
            }
        }

        return { success: true, message: "Human Passport identity added" }
    } catch (error: any) {
        log.error(`[GCRIdentityRoutines] Failed to add Human Passport identity: ${error.message}`)
        return { success: false, message: error.message || "Failed to add Human Passport identity" }
    }
}

export async function applyHumanPassportIdentityRemove(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const data = editOperation.data as { address: string }
    const normalizedAddress = data.address.toLowerCase()

    const accountGCR = await gcrMainRepository.findOneBy({
        pubkey: editOperation.account,
    })

    if (!accountGCR) {
        return { success: false, message: "Account not found" }
    }

    if (!accountGCR.identities.humanpassport || accountGCR.identities.humanpassport.length === 0) {
        return { success: false, message: "No Human Passport identities found" }
    }

    const addressExists = accountGCR.identities.humanpassport.some(
        (hp: SavedHumanPassportIdentity) =>
            hp.address.toLowerCase() === normalizedAddress,
    )

    if (!addressExists) {
        return { success: false, message: "Identity not found" }
    }

    accountGCR.identities.humanpassport =
        accountGCR.identities.humanpassport.filter(
            (hp: SavedHumanPassportIdentity) =>
                hp.address.toLowerCase() !== normalizedAddress,
        )

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyHumanPassportIdentityRemove")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }

        await IncentiveManager.humanPassportUnlinked(accountGCR.pubkey)
    }

    return { success: true, message: "Human Passport identity removed" }
}
