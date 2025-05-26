import {
    IdentityPayload,
    InferFromSignaturePayload,
    Web2CoreTargetIdentityPayload,
} from "@kynesyslabs/demosdk/abstraction"
import IdentityManager from "@/libs/blockchain/gcr/gcr_routines/identityManager"
import { verifyWeb2Proof } from "@/libs/abstraction"
import { RPCResponse } from "@kynesyslabs/demosdk/types"

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
                sender,
            )
        case "xm_identity_remove":
        case "web2_identity_remove":
            return {
                success: true,
                message: "Identity removed",
            }
        default:
            return {
                success: false,
                // @ts-expect-error - we should never get here
                message: `Unsupported identity method: ${payload.method}`,
            }
    }
}
