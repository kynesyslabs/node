import {
    IdentityPayload,
    InferFromSignaturePayload,
    Web2CoreTargetIdentityPayload,
} from "@kynesyslabs/demosdk/abstraction"
import IdentityManager from "@/libs/blockchain/gcr/gcr_routines/identityManager"
import { verifyWeb2Proof } from "@/libs/abstraction"
import { IncentiveController } from "@/features/incentive/IncentiveController"
import { verifyCloudflareTurnstileToken } from "@/utilities/turnstile"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { forgeToHex } from "@/libs/crypto/forgeUtils"

// Define response types for better type checking
interface IdentityResponse {
    success: boolean
    message: string
    response?: RPCResponse
}

/**
 * Verifies the signature in the identity payload using the appropriate handler
 *
 * @param payload - The identity payload
 * @param sender - The sender's address (from the transaction)
 * @returns Response with success status, message, and optional data
 */
export default async function handleIdentityRequest(
    payload: IdentityPayload,
    sender: string,
): Promise<IdentityResponse> {
    switch (payload.method) {
        case "xm_identity_assign":
            return await IdentityManager.verifyPayload(
                payload.payload as InferFromSignaturePayload,
            )
        case "web2_identity_assign":
            return await verifyWeb2Proof(
                payload.payload as Web2CoreTargetIdentityPayload,
            )
        case "xm_identity_remove":
        case "web2_identity_remove":
            return {
                success: true,
                message: "Identity removed",
            }
        case "query_points":
            try {
                if (!sender) {
                    return {
                        success: false,
                        message: "Missing sender address for points query",
                    }
                }
                const senderHex = forgeToHex(sender)
                const incentiveController = IncentiveController.getInstance()
                const pointsResponse = await incentiveController.onGetPoints(
                    senderHex,
                )

                return {
                    success: true,
                    message: "Points retrieved successfully",
                    response: pointsResponse,
                }
            } catch (error) {
                return {
                    success: false,
                    message: `Error querying points: ${error}`,
                }
            }

        //TODO To be implemented
        case "verify_turnstile":
            try {
                const tokenData =
                    // @ts-expect-error - need to fix this
                    payload.payload as Web2CoreTargetIdentityPayload
                const token = tokenData?.proof

                if (!token) {
                    return {
                        success: false,
                        message: "Missing Turnstile token",
                    }
                }

                const isValid = await verifyCloudflareTurnstileToken(token)

                return {
                    success: isValid,
                    message: isValid
                        ? "Turnstile token verified successfully"
                        : "Invalid Turnstile token",
                }
            } catch (error) {
                return {
                    success: false,
                    message: `Error verifying Turnstile token: ${error}`,
                }
            }

        default:
            return {
                success: false,
                // @ts-expect-error - we should never get here
                message: `Unsupported identity method: ${payload.method}`,
            }
    }
}
