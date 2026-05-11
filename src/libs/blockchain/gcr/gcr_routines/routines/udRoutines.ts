import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../../handleGCR"
import { UDIdentityAssignPayload } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import ensureGCRForUser from "../ensureGCRForUser"
import { SavedUdIdentity } from "@/model/entities/types/IdentityTypes"
import { IncentiveManager } from "../IncentiveManager"
import { safeGCRSave, isFirstConnection } from "./utils"

export async function applyUdIdentityAdd(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const payload = editOperation.data as UDIdentityAssignPayload["payload"]

    // REVIEW: Validate required fields presence
    if (
        !payload.domain ||
        !payload.signingAddress ||
        !payload.signatureType ||
        !payload.signature ||
        !payload.publicKey ||
        !payload.timestamp ||
        !payload.signedData ||
        !payload.network ||
        !payload.registryType
    ) {
        return {
            success: false,
            message: "Invalid edit operation data: missing required fields",
        }
    }

    // Validate enum fields have allowed values
    const validNetworks = ["polygon", "base", "sonic", "ethereum", "solana"]
    const validRegistryTypes = ["UNS", "CNS"]

    if (!validNetworks.includes(payload.network)) {
        return {
            success: false,
            message: `Invalid network: ${
                payload.network
            }. Must be one of: ${validNetworks.join(", ")}`,
        }
    }
    if (!validRegistryTypes.includes(payload.registryType)) {
        return {
            success: false,
            message: `Invalid registryType: ${payload.registryType}. Must be "UNS" or "CNS"`,
        }
    }

    // Validate timestamp is a valid positive number
    if (
        typeof payload.timestamp !== "number" ||
        isNaN(payload.timestamp) ||
        payload.timestamp <= 0
    ) {
        return {
            success: false,
            message: `Invalid timestamp: ${payload.timestamp}. Must be a positive number (epoch milliseconds)`,
        }
    }

    accountGCR.identities.ud = accountGCR.identities.ud || []

    // Check if domain already exists for this account
    const domainExists = accountGCR.identities.ud.some(
        (id: SavedUdIdentity) =>
            id.domain.toLowerCase() === payload.domain.toLowerCase(),
    )

    if (domainExists) {
        return {
            success: false,
            message: "Domain already linked to this account",
        }
    }

    accountGCR.identities.ud.push(payload)

    async function awardPoints() {
        /**
         * Check if this is the first connection for this domain
         */
        const isFirst = await isFirstConnection(
            "ud",
            { domain: payload.domain },
            editOperation.account,
        )

        /**
         * Award incentive points for UD domain linking
         */
        if (isFirst) {
            await IncentiveManager.udDomainLinked(
                accountGCR.pubkey,
                payload.domain,
                payload.signingAddress,
                editOperation.referralCode,
            )
        }
    }

    return {
        success: true,
        message: "UD identity added",
        entity: accountGCR,
        sideEffect: awardPoints,
    }
}

export async function applyUdIdentityRemove(
    editOperation: any,
    accountGCR: GCRMain,
): Promise<GCRResult> {
    const { domain } = editOperation.data

    if (!domain) {
        return { success: false, message: "Invalid edit operation data" }
    }

    if (!accountGCR.identities || !accountGCR.identities.ud) {
        return {
            success: false,
            message: "No UD identities found",
        }
    }

    const domainExists = accountGCR.identities.ud.some(
        (id: SavedUdIdentity) =>
            id.domain.toLowerCase() === domain.toLowerCase(),
    )

    if (!domainExists) {
        return { success: false, message: "Domain not found" }
    }

    accountGCR.identities.ud = accountGCR.identities.ud.filter(
        (id: SavedUdIdentity) =>
            id.domain.toLowerCase() !== domain.toLowerCase(),
    )

    async function deductPoints() {
        await IncentiveManager.udDomainUnlinked(accountGCR.pubkey, domain)
    }

    return {
        success: true,
        message: "UD identity removed",
        entity: accountGCR,
        sideEffect: deductPoints,
    }
}
