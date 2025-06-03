import {
    IdentityPayload,
    InferFromSignaturePayload,
    Web2CoreTargetIdentityPayload,
} from "@kynesyslabs/demosdk/abstraction"
import { verifyWeb2Proof } from "@/libs/abstraction"
import { Transaction } from "@kynesyslabs/demosdk/types"
import { PqcIdentityAssignPayload } from "@kynesyslabs/demosdk/abstraction"
import IdentityManager from "@/libs/blockchain/gcr/gcr_routines/identityManager"

interface IdentityResponse {
    success: boolean
    message: string
}

/**
 * Verifies the signature in the identity payload using the appropriate handler
 *
 * @param payload - The identity payload
 * @param sender - The sender's address (from the transaction)
 * @returns Response with success status, message, and optional data
 */
export default async function handleIdentityRequest(
    tx: Transaction,
    sender: string,
) : Promise<IdentityResponse> {
    const payload = tx.content.data[1] as IdentityPayload
    const senderEd25519 = tx.content.from_ed25519_address

    switch (payload.method) {
        case "xm_identity_assign":
            // NOTE: Sender here is the ed25519 address coming from the transaction body
            // because the xm identity tx can be signed with both ed25519 and pqc.
            // The sender address here will be the message to verify using the signature in the payload.
            return await IdentityManager.verifyPayload(
                payload.payload as InferFromSignaturePayload,
                senderEd25519,
            )
        case "pqc_identity_assign":
            // NOTE: Sender here should be the ed25519 address coming from the request headers
            return await IdentityManager.verifyPqcPayload(
                payload.payload as PqcIdentityAssignPayload["payload"],
                sender,
            )
        case "web2_identity_assign":
            // NOTE: Sender here should be the ed25519 address coming from the request headers
            return await verifyWeb2Proof(
                payload.payload as Web2CoreTargetIdentityPayload,
                sender,
            )
        case "xm_identity_remove":
        case "pqc_identity_remove":
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
