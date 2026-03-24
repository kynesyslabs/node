import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Web2GCRData } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import Hashing from "@/libs/crypto/hashing"
import log from "@/utilities/logger"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection } from "./utils"

export async function applyWeb2IdentityAdd(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const { context, data } = editOperation.data as Web2GCRData
    const accountGCR = await ensureGCRForUser(editOperation.account)

    accountGCR.identities.web2 = accountGCR.identities.web2 || {}
    accountGCR.identities.web2[context] =
        accountGCR.identities.web2[context] || []

    const exists = accountGCR.identities.web2[context].some(
        (id: Web2GCRData["data"]) => id.userId === data.userId,
    )

    if (exists) {
        return { success: false, message: "Identity already exists" }
    }

    /**
     * Verify the proof
     */
    let proofOk = false

    if (context === "telegram") {
        // Telegram uses dual signature validation (user + bot signatures)
        // The proof is a TelegramSignedAttestation object, not a URL
        try {
            // Import verifyWeb2Proof which handles telegram verification
            const { verifyWeb2Proof } = await import("@/libs/abstraction")

            const verificationResult = await verifyWeb2Proof(
                {
                    context: "telegram",
                    username: data.username,
                    userId: data.userId,
                    proof: data.proof,
                },
                accountGCR.pubkey, // sender's ed25519 address
            )

            proofOk = verificationResult.success

            if (!proofOk) {
                log.error(
                    `Telegram verification failed: ${verificationResult.message}`,
                )
                return {
                    success: false,
                    message: verificationResult.message,
                }
            }

            log.info(
                `Telegram identity verified: ${data.username} (${data.userId})`,
            )
        } catch (error) {
            log.error(`Telegram proof verification failed: ${error}`)
            proofOk = false
        }
    } else {
        // Standard SHA256 proof validation for other platforms
        proofOk = Hashing.sha256(data.proof) === data.proofHash
    }

    if (!proofOk) {
        return {
            success: false,
            message:
                context === "telegram"
                    ? "Telegram attestation validation failed"
                    : "Sha256 proof mismatch: Expected " +
                      data.proofHash +
                      " but got " +
                      Hashing.sha256(data.proof),
        }
    }

    accountGCR.identities.web2[context].push(data)

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyWeb2IdentityAdd")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }

        /**
         * Only award points if this is the first time this identity is being connected
         */
        if (context === "twitter") {
            const isFirst = await isFirstConnection(
                "twitter",
                { userId: data.userId },
                gcrMainRepository,
                editOperation.account,
            )
            if (isFirst) {
                await IncentiveManager.twitterLinked(
                    editOperation.account,
                    data.userId,
                    editOperation.referralCode,
                )
            }
        } else if (context === "github") {
            const isFirst = await isFirstConnection(
                "github",
                { userId: data.userId },
                gcrMainRepository,
                editOperation.account,
            )
            if (isFirst) {
                await IncentiveManager.githubLinked(
                    editOperation.account,
                    data.userId,
                    editOperation.referralCode,
                )
            }
        } else if (context === "telegram") {
            const isFirst = await isFirstConnection(
                "telegram",
                { userId: data.userId },
                gcrMainRepository,
                editOperation.account,
            )
            if (isFirst) {
                // REVIEW: Pass attestation to check group membership for conditional points
                await IncentiveManager.telegramLinked(
                    editOperation.account,
                    data.userId,
                    editOperation.referralCode,
                    data.proof, // TelegramSignedAttestation with group_membership field
                )
            }
        } else if (context === "discord") {
            const isFirst = await isFirstConnection(
                "discord",
                { userId: data.userId },
                gcrMainRepository,
                editOperation.account,
            )
            if (isFirst) {
                await IncentiveManager.discordLinked(
                    editOperation.account,
                    editOperation.referralCode,
                )
            }
        } else {
            log.info(`Web2 identity linked: ${context}/${data.username}`)
        }
    }

    return { success: true, message: "Web2 identity added" }
}

export async function applyWeb2IdentityRemove(
    editOperation: any,
    gcrMainRepository: Repository<GCRMain>,
    simulate: boolean,
): Promise<GCRResult> {
    const { context, username } = editOperation.data as {
        context: string
        username: string
    }
    const accountGCR = await ensureGCRForUser(editOperation.account)

    accountGCR.identities.web2 = accountGCR.identities.web2 || {}
    accountGCR.identities.web2[context] =
        accountGCR.identities.web2[context] || []

    const exists = accountGCR.identities.web2[context].some(
        (id: Web2GCRData["data"]) => id.username === username,
    )

    if (!exists) {
        return { success: false, message: "Identity not found" }
    }

    // Store the identity being removed for GitHub and Telegram unlinking (need userId)
    let removedIdentity: Web2GCRData["data"] | null = null
    if (context === "github" || context === "telegram") {
        removedIdentity =
            accountGCR.identities.web2[context].find(
                (id: Web2GCRData["data"]) => id.username === username,
            ) || null
    }

    accountGCR.identities.web2[context] = accountGCR.identities.web2[
        context
    ].filter((id: Web2GCRData["data"]) => id.username !== username)

    if (!simulate) {
        const saveResult = await safeGCRSave(gcrMainRepository, accountGCR, "applyWeb2IdentityRemove")
        if (!saveResult.success) {
            return { success: false, message: saveResult.error || "Database save failed" }
        }

        /**
         * Deduct incentive points for Twitter unlinking
         */
        if (context === "twitter") {
            await IncentiveManager.twitterUnlinked(editOperation.account)
        } else if (
            context === "github" &&
            removedIdentity &&
            removedIdentity.userId
        ) {
            await IncentiveManager.githubUnlinked(
                editOperation.account,
                removedIdentity.userId,
            )
        } else if (
            context === "telegram" &&
            removedIdentity &&
            removedIdentity.userId
        ) {
            await IncentiveManager.telegramUnlinked(editOperation.account)
        } else if (context === "discord") {
            await IncentiveManager.discordUnlinked(editOperation.account)
        }
    }

    return { success: true, message: "Web2 identity removed" }
}
