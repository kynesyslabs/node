import {
    IdentityPayload,
    InferFromSignaturePayload,
    Web2CoreTargetIdentityPayload,
} from "@kynesyslabs/demosdk/abstraction"
import IdentityManager from "@/libs/blockchain/gcr/gcr_routines/identityManager"
import { verifyWeb2Proof } from "@/libs/abstraction"

/**
 * Verifies the signature in the identity payload using the appropriate handler
 *
 * @param payload - The identity payload
 * @returns true if the identity request is valid, false otherwise
 */
export default async function handleIdentityRequest(payload: IdentityPayload) {
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
        default:
            return {
                success: false,
                // @ts-expect-error - we should never get here
                message: `Unsupported identity method: ${payload.method}`,
            }
    }
}
