// REVIEW: GCR handlers for OmniProtocol binary communication
import { OmniHandler } from "../../types/message"
import { decodeJsonRequest } from "../../serialization/jsonEnvelope"
import { encodeResponse, errorResponse, successResponse } from "./utils"
import { encodeAddressInfoResponse } from "../../serialization/gcr"

interface AddressInfoRequest {
    address?: string
}

interface IdentitiesRequest {
    address: string
}

interface PointsRequest {
    address: string
}

interface ReferralInfoRequest {
    address: string
}

interface ValidateReferralRequest {
    code: string
}

interface AccountByIdentityRequest {
    identity: string
}

interface IdentityAssignRequest {
    editOperation: {
        type: "identity"
        isRollback: boolean
        account: string
        context: "xm" | "web2" | "pqc" | "ud"
        operation: "add" | "remove"
        data: any  // Varies by context - see GCREditIdentity
        txhash: string
        referralCode?: string
    }
}

/**
 * Handler for 0x41 GCR_IDENTITY_ASSIGN opcode
 *
 * Internal operation triggered by write transactions to assign/remove identities.
 * Uses GCRIdentityRoutines to apply identity changes (xm, web2, pqc, ud).
 */
export const handleIdentityAssign: OmniHandler = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for identityAssign"))
    }

    try {
        const request = decodeJsonRequest<IdentityAssignRequest>(message.payload)

        if (!request.editOperation) {
            return encodeResponse(errorResponse(400, "editOperation is required"))
        }

        const { editOperation } = request

        // Validate required fields
        if (editOperation.type !== "identity") {
            return encodeResponse(errorResponse(400, "Invalid edit operation type, expected 'identity'"))
        }

        if (!editOperation.account) {
            return encodeResponse(errorResponse(400, "account is required"))
        }

        if (!editOperation.context || !["xm", "web2", "pqc", "ud"].includes(editOperation.context)) {
            return encodeResponse(errorResponse(400, "Invalid context, must be xm, web2, pqc, or ud"))
        }

        if (!editOperation.operation || !["add", "remove"].includes(editOperation.operation)) {
            return encodeResponse(errorResponse(400, "Invalid operation, must be add or remove"))
        }

        if (!editOperation.data) {
            return encodeResponse(errorResponse(400, "data is required"))
        }

        if (!editOperation.txhash) {
            return encodeResponse(errorResponse(400, "txhash is required"))
        }

        // Import GCR routines
        const { default: gcrIdentityRoutines } = await import(
            "src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines"
        )
        const { default: datasource } = await import("src/model/datasource")
        const { GCRMain: gcrMain } = await import("@/model/entities/GCRv2/GCR_Main")

        const gcrMainRepository = datasource.getRepository(gcrMain)

        // Apply the identity operation (simulate = false for actual execution)
        const result = await gcrIdentityRoutines.apply(
            editOperation,
            gcrMainRepository,
            false,  // simulate = false (actually apply changes)
        )

        if (result.success) {
            return encodeResponse(successResponse({
                success: true,
                message: result.message,
            }))
        } else {
            return encodeResponse(errorResponse(400, result.message || "Identity assignment failed"))
        }
    } catch (error) {
        console.error("[handleIdentityAssign] Error:", error)
        return encodeResponse(errorResponse(500, "Internal error", error instanceof Error ? error.message : error))
    }
}

export const handleGetAddressInfo: OmniHandler = async ({ message }) => {
    if (!message.payload || message.payload.length === 0) {
        return encodeResponse(
            errorResponse(400, "Missing payload for getAddressInfo"),
        )
    }

    const payload = decodeJsonRequest<AddressInfoRequest>(message.payload)

    if (!payload.address) {
        return encodeResponse(errorResponse(400, "address is required"))
    }

    try {
        const { default: ensureGCRForUser } = await import(
            "src/libs/blockchain/gcr/gcr_routines/ensureGCRForUser"
        )
        const info = await ensureGCRForUser(payload.address)

        const balance = BigInt(
            typeof info.balance === "string"
                ? info.balance
                : info.balance ?? 0,
        )
        const nonce = BigInt(info.nonce ?? 0)
        const additional = Buffer.from(JSON.stringify(info), "utf8")

        return encodeAddressInfoResponse({
            status: 200,
            balance,
            nonce,
            additionalData: additional,
        })
    } catch (error) {
        return encodeResponse(
            errorResponse(400, "error", error instanceof Error ? error.message : error),
        )
    }
}

/**
 * Handler for 0x42 GCR_GET_IDENTITIES opcode
 *
 * Returns all identities (web2, xm, pqc) for a given address.
 */
export const handleGetIdentities: OmniHandler = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for getIdentities"))
    }

    try {
        const request = decodeJsonRequest<IdentitiesRequest>(message.payload)

        if (!request.address) {
            return encodeResponse(errorResponse(400, "address is required"))
        }

        const { default: manageGCRRoutines } = await import("../../../network/manageGCRRoutines")

        const httpPayload = {
            method: "getIdentities" as const,
            params: [request.address],
        }

        const httpResponse = await manageGCRRoutines(context.peerIdentity, httpPayload)

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(errorResponse(httpResponse.result, "Failed to get identities", httpResponse.extra))
        }
    } catch (error) {
        console.error("[handleGetIdentities] Error:", error)
        return encodeResponse(errorResponse(500, "Internal error", error instanceof Error ? error.message : error))
    }
}

/**
 * Handler for 0x43 GCR_GET_WEB2_IDENTITIES opcode
 *
 * Returns web2 identities only (twitter, github, discord) for a given address.
 */
export const handleGetWeb2Identities: OmniHandler = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for getWeb2Identities"))
    }

    try {
        const request = decodeJsonRequest<IdentitiesRequest>(message.payload)

        if (!request.address) {
            return encodeResponse(errorResponse(400, "address is required"))
        }

        const { default: manageGCRRoutines } = await import("../../../network/manageGCRRoutines")

        const httpPayload = {
            method: "getWeb2Identities" as const,
            params: [request.address],
        }

        const httpResponse = await manageGCRRoutines(context.peerIdentity, httpPayload)

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(errorResponse(httpResponse.result, "Failed to get web2 identities", httpResponse.extra))
        }
    } catch (error) {
        console.error("[handleGetWeb2Identities] Error:", error)
        return encodeResponse(errorResponse(500, "Internal error", error instanceof Error ? error.message : error))
    }
}

/**
 * Handler for 0x44 GCR_GET_XM_IDENTITIES opcode
 *
 * Returns crosschain/XM identities only for a given address.
 */
export const handleGetXmIdentities: OmniHandler = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for getXmIdentities"))
    }

    try {
        const request = decodeJsonRequest<IdentitiesRequest>(message.payload)

        if (!request.address) {
            return encodeResponse(errorResponse(400, "address is required"))
        }

        const { default: manageGCRRoutines } = await import("../../../network/manageGCRRoutines")

        const httpPayload = {
            method: "getXmIdentities" as const,
            params: [request.address],
        }

        const httpResponse = await manageGCRRoutines(context.peerIdentity, httpPayload)

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(errorResponse(httpResponse.result, "Failed to get XM identities", httpResponse.extra))
        }
    } catch (error) {
        console.error("[handleGetXmIdentities] Error:", error)
        return encodeResponse(errorResponse(500, "Internal error", error instanceof Error ? error.message : error))
    }
}

/**
 * Handler for 0x45 GCR_GET_POINTS opcode
 *
 * Returns incentive points breakdown for a given address.
 */
export const handleGetPoints: OmniHandler = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for getPoints"))
    }

    try {
        const request = decodeJsonRequest<PointsRequest>(message.payload)

        if (!request.address) {
            return encodeResponse(errorResponse(400, "address is required"))
        }

        const { default: manageGCRRoutines } = await import("../../../network/manageGCRRoutines")

        const httpPayload = {
            method: "getPoints" as const,
            params: [request.address],
        }

        const httpResponse = await manageGCRRoutines(context.peerIdentity, httpPayload)

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(errorResponse(httpResponse.result, "Failed to get points", httpResponse.extra))
        }
    } catch (error) {
        console.error("[handleGetPoints] Error:", error)
        return encodeResponse(errorResponse(500, "Internal error", error instanceof Error ? error.message : error))
    }
}

/**
 * Handler for 0x46 GCR_GET_TOP_ACCOUNTS opcode
 *
 * Returns leaderboard of top accounts by incentive points.
 * No parameters required - returns all top accounts.
 */
export const handleGetTopAccounts: OmniHandler = async ({ message, context }) => {
    try {
        const { default: manageGCRRoutines } = await import("../../../network/manageGCRRoutines")

        const httpPayload = {
            method: "getTopAccountsByPoints" as const,
            params: [],
        }

        const httpResponse = await manageGCRRoutines(context.peerIdentity, httpPayload)

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(errorResponse(httpResponse.result, "Failed to get top accounts", httpResponse.extra))
        }
    } catch (error) {
        console.error("[handleGetTopAccounts] Error:", error)
        return encodeResponse(errorResponse(500, "Internal error", error instanceof Error ? error.message : error))
    }
}

/**
 * Handler for 0x47 GCR_GET_REFERRAL_INFO opcode
 *
 * Returns referral information for a given address.
 */
export const handleGetReferralInfo: OmniHandler = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for getReferralInfo"))
    }

    try {
        const request = decodeJsonRequest<ReferralInfoRequest>(message.payload)

        if (!request.address) {
            return encodeResponse(errorResponse(400, "address is required"))
        }

        const { default: manageGCRRoutines } = await import("../../../network/manageGCRRoutines")

        const httpPayload = {
            method: "getReferralInfo" as const,
            params: [request.address],
        }

        const httpResponse = await manageGCRRoutines(context.peerIdentity, httpPayload)

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(errorResponse(httpResponse.result, "Failed to get referral info", httpResponse.extra))
        }
    } catch (error) {
        console.error("[handleGetReferralInfo] Error:", error)
        return encodeResponse(errorResponse(500, "Internal error", error instanceof Error ? error.message : error))
    }
}

/**
 * Handler for 0x48 GCR_VALIDATE_REFERRAL opcode
 *
 * Validates a referral code and returns referrer information.
 */
export const handleValidateReferral: OmniHandler = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for validateReferral"))
    }

    try {
        const request = decodeJsonRequest<ValidateReferralRequest>(message.payload)

        if (!request.code) {
            return encodeResponse(errorResponse(400, "code is required"))
        }

        const { default: manageGCRRoutines } = await import("../../../network/manageGCRRoutines")

        const httpPayload = {
            method: "validateReferralCode" as const,
            params: [request.code],
        }

        const httpResponse = await manageGCRRoutines(context.peerIdentity, httpPayload)

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(errorResponse(httpResponse.result, "Failed to validate referral", httpResponse.extra))
        }
    } catch (error) {
        console.error("[handleValidateReferral] Error:", error)
        return encodeResponse(errorResponse(500, "Internal error", error instanceof Error ? error.message : error))
    }
}

/**
 * Handler for 0x49 GCR_GET_ACCOUNT_BY_IDENTITY opcode
 *
 * Looks up an account by identity (e.g., twitter username, discord id).
 */
export const handleGetAccountByIdentity: OmniHandler = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
        return encodeResponse(errorResponse(400, "Missing payload for getAccountByIdentity"))
    }

    try {
        const request = decodeJsonRequest<AccountByIdentityRequest>(message.payload)

        if (!request.identity) {
            return encodeResponse(errorResponse(400, "identity is required"))
        }

        const { default: manageGCRRoutines } = await import("../../../network/manageGCRRoutines")

        const httpPayload = {
            method: "getAccountByIdentity" as const,
            params: [request.identity],
        }

        const httpResponse = await manageGCRRoutines(context.peerIdentity, httpPayload)

        if (httpResponse.result === 200) {
            return encodeResponse(successResponse(httpResponse.response))
        } else {
            return encodeResponse(errorResponse(httpResponse.result, "Failed to get account by identity", httpResponse.extra))
        }
    } catch (error) {
        console.error("[handleGetAccountByIdentity] Error:", error)
        return encodeResponse(errorResponse(500, "Internal error", error instanceof Error ? error.message : error))
    }
}
