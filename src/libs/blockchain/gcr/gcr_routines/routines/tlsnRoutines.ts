import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { Web2GCRData } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import Hashing from "@/libs/crypto/hashing"
import log from "@/utilities/logger"
import { IncentiveManager } from "../IncentiveManager"
import {
    verifyTLSNProof,
    type TLSNIdentityPayload,
    type TLSNProofRanges,
    type TLSNotaryPresentation,
} from "@/libs/tlsnotary"
import { safeGCRSave, isFirstConnection } from "./utils"

/**
 * Expected API endpoints for TLSN verification per context
 */
const TLSN_EXPECTED_ENDPOINTS: Record<
    string,
    { server: string; pathPrefix: string }
> = {
    github: { server: "api.github.com", pathPrefix: "/user" },
    discord: { server: "discord.com", pathPrefix: "/api/users/@me" },
    telegram: {
        server: "telegram-backend",
        pathPrefix: "/api/telegram/user",
    },
}

/**
 * Add an identity via TLSNotary proof verification.
 */
export async function applyTLSNIdentityAdd(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    // Extract context from editOperation.data (top level)
    const { context } = editOperation.data
    // Extract nested data fields (proof, username, userId are inside data.data)
    const {
        proof: proofString,
        recvHash,
        proofRanges,
        revealedRecv,
        username,
        userId,
    } = editOperation.data.data || {}
    // referralCode is at the editOperation level
    const referralCode = editOperation.referralCode

    if (!context) {
        return {
            success: false,
            message: "Missing TLSN context",
        }
    }

    if (!username) {
        return {
            success: false,
            message: "Missing TLSN username",
        }
    }

    if (userId === undefined || userId === null) {
        return {
            success: false,
            message: "Missing TLSN userId",
        }
    }

    if (proofString === undefined || proofString === null) {
        return {
            success: false,
            message: "Missing TLSN proof",
        }
    }

    if (!recvHash) {
        return {
            success: false,
            message: "Missing TLSN recvHash",
        }
    }

    if (!proofRanges) {
        return {
            success: false,
            message: "Missing TLSN proofRanges",
        }
    }

    if (revealedRecv === undefined || revealedRecv === null) {
        return {
            success: false,
            message: "Missing TLSN revealedRecv",
        }
    }

    // Parse the proof JSON string back to object
    let proof: any
    try {
        proof =
            typeof proofString === "string"
                ? JSON.parse(proofString)
                : proofString
    } catch (e) {
        return {
            success: false,
            message: "Invalid proof: failed to parse proof JSON string",
        }
    }

    // 1. Validate context is supported
    if (!TLSN_EXPECTED_ENDPOINTS[context]) {
        return {
            success: false,
            message: `Unsupported TLSN context: ${context}`,
        }
    }

    // 2. Validate proof structure
    if (!proof || typeof proof !== "object") {
        return {
            success: false,
            message: "Invalid proof: expected TLSNotary presentation object",
        }
    }

    if (!proof.data || !proof.version) {
        return {
            success: false,
            message: "Invalid proof structure: missing data or version",
        }
    }

    // 3. Verify proof and validate recvHash/proofRanges-derived identity claims
    const verification = await verifyTLSNProof({
        context,
        proof: proof as TLSNotaryPresentation,
        recvHash,
        proofRanges: proofRanges as TLSNProofRanges,
        revealedRecv,
        username: String(username),
        userId: String(userId),
        referralCode,
    } as TLSNIdentityPayload)

    if (!verification.success) {
        log.warn(
            `[TLSN Identity] Proof verification failed: ${verification.message}`,
        )
        return {
            success: false,
            message: verification.message,
        }
    }

    accountGCR.identities.web2 = accountGCR.identities.web2 || {}
    accountGCR.identities.web2[context] =
        accountGCR.identities.web2[context] || []

    // Check if identity already exists (by userId to prevent duplicate registrations)
    const exists = accountGCR.identities.web2[context].some(
        (id: Web2GCRData["data"]) => id.userId === String(userId),
    )

    if (exists) {
        return { success: false, message: "Identity already exists" }
    }

    // 9. Prepare data for storage
    const proofHash = Hashing.sha256(JSON.stringify(proof))
    const data = {
        userId: String(userId),
        username: username,
        proof: proof,
        proofHash: proofHash,
        proofType: "tlsn", // Mark as TLSNotary-verified
        timestamp: Date.now(),
    }

    accountGCR.identities.web2[context].push(data)

    // 10. Save and award incentives
    const awardPoints = async () => {
        if (context === "github") {
            const isFirst = await isFirstConnection(
                "github",
                { userId: String(userId) },
                editOperation.account,
            )

            if (isFirst) {
                await IncentiveManager.githubLinked(
                    editOperation.account,
                    String(userId),
                    referralCode,
                )
            }
        } else if (context === "discord") {
            const isFirst = await isFirstConnection(
                "discord",
                { userId: String(userId) },
                editOperation.account,
            )

            if (isFirst) {
                await IncentiveManager.discordLinked(
                    editOperation.account,
                    referralCode,
                )
            }
        } else if (context === "telegram") {
            const isFirst = await isFirstConnection(
                "telegram",
                { userId: String(userId) },
                editOperation.account,
            )

            if (isFirst) {
                await IncentiveManager.telegramTLSNLinked(
                    editOperation.account,
                    String(userId),
                    referralCode,
                )
            }
        }
    }

    return {
        success: true,
        message: "TLSN identity added successfully",
        entity: accountGCR,
        sideEffect: awardPoints,
    }
}

/**
 * Remove an identity that was added via TLSNotary.
 *
 * Removes only TLSN-proven identities (proofType === "tlsn") from web2 storage.
 */
export async function applyTLSNIdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const { context, username } = editOperation.data as {
        context?: string
        username?: string
    }

    if (!context || !username) {
        return {
            success: false,
            message: "Invalid payload: missing context or username",
        }
    }

    if (!TLSN_EXPECTED_ENDPOINTS[context]) {
        return {
            success: false,
            message: `Unsupported TLSN context: ${context}`,
        }
    }

    accountGCR.identities.web2 = accountGCR.identities.web2 || {}
    accountGCR.identities.web2[context] =
        accountGCR.identities.web2[context] || []

    const isMatch = (id: Web2GCRData["data"] & { proofType?: string }) => {
        // TLSN remove must never affect legacy/non-TLSN web2 identities.
        if (id.proofType !== "tlsn") {
            return false
        }
        return id.username === username
    }

    // Find the TLSN identity to remove
    const identity = accountGCR.identities.web2[context].find(
        (id: Web2GCRData["data"]) =>
            isMatch(id as Web2GCRData["data"] & { proofType?: string }),
    )

    if (!identity) {
        return { success: false, message: "TLSN identity not found" }
    }

    // Filter out only the matching TLSN identity
    accountGCR.identities.web2[context] = accountGCR.identities.web2[
        context
    ].filter(
        (id: Web2GCRData["data"]) =>
            !isMatch(id as Web2GCRData["data"] & { proofType?: string }),
    )

    const deductPoints = async () => {
        // Trigger TLSN incentive rollback only for confirmed TLSN provenance.
        if (context === "github" && identity.userId) {
            await IncentiveManager.githubUnlinked(
                editOperation.account,
                identity.userId,
            )
        } else if (context === "discord") {
            await IncentiveManager.discordUnlinked(editOperation.account)
        } else if (context === "telegram") {
            await IncentiveManager.telegramUnlinked(editOperation.account)
        }
    }

    return {
        success: true,
        message: "TLSN identity removed successfully",
        entity: accountGCR,
        sideEffect: deductPoints,
    }
}
