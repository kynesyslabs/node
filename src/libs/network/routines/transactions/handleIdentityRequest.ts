import {
    IdentityPayload,
    InferFromSignaturePayload,
    Web2CoreTargetIdentityPayload,
    UDIdentityAssignPayload,
} from "@kynesyslabs/demosdk/abstraction"
import { verifyWeb2Proof } from "@/libs/abstraction"
import { Transaction } from "@kynesyslabs/demosdk/types"
import { PqcIdentityAssignPayload } from "@kynesyslabs/demosdk/abstraction"
import IdentityManager from "@/libs/blockchain/gcr/gcr_routines/identityManager"
import { UDIdentityManager } from "@/libs/blockchain/gcr/gcr_routines/udIdentityManager"
import { NomisWalletIdentity, EthosWalletIdentity } from "@/model/entities/types/IdentityTypes"
import { Referrals } from "@/features/incentive/referrals"
import { verifyTLSNProof, TLSNIdentityPayload } from "@/libs/tlsnotary"

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
): Promise<IdentityResponse> {
    const payload = tx.content.data[1] as IdentityPayload & {
        payload: {
            referralCode?: string
        }
    }
    const referralCode = payload.payload.referralCode

    if (referralCode) {
        const referrerAccount = await Referrals.findAccountByReferralCode(
            referralCode,
        )

        if (!referrerAccount) {
            return {
                success: false,
                message: "Error: Referrer account not found",
            }
        }

        if (referrerAccount.pubkey === tx.content.from_ed25519_address) {
            return {
                success: false,
                message: "Error: Referrer and new user are the same",
            }
        }
    }

    if (tx.content.from_ed25519_address !== sender) {
        return {
            success: false,
            message: "Error: Tx sender and request sender address do not match",
        }
    }

    switch (payload.method) {
        case "xm_identity_assign":
            // NOTE: Sender here is the ed25519 address coming from the transaction body
            // because the xm identity tx can be signed with both ed25519 and pqc.
            // The sender address here will be the message to verify using the signature in the payload.
            return await IdentityManager.verifyPayload(
                payload.payload as InferFromSignaturePayload,
                sender,
            )
        case "ud_identity_assign":
            // NOTE: Sender here is the ed25519 address coming from the transaction body
            // UD follows signature-based verification like XM
            // Type assertion needed: UDIdentityAssignPayload imported from different SDK paths
            // (abstraction vs types) creates incompatible types despite identical structure.
            // Unlike other handlers that pass payload.payload, UD's verifyPayload expects
            // the full wrapper object with nested .payload property.
            return await UDIdentityManager.verifyPayload(
                payload as unknown as Parameters<typeof UDIdentityManager.verifyPayload>[0],
                sender,
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
        case "nomis_identity_assign":
            return await IdentityManager.verifyNomisPayload(
                payload.payload as NomisWalletIdentity,
            )
        case "ethos_identity_assign":
            return await IdentityManager.verifyEthosPayload(
                payload.payload as EthosWalletIdentity,
            )
        case "tlsn_identity_assign":
            // TLSNotary identity verification - verify proof structure
            return await verifyTLSNProof(payload.payload as TLSNIdentityPayload)
        case "xm_identity_remove":
        case "pqc_identity_remove":
        case "web2_identity_remove":
        case "nomis_identity_remove":
        case "ethos_identity_remove":
        case "ud_identity_remove":
        case "tlsn_identity_remove":
            return {
                success: true,
                message: "Identity removed",
            }
        default:
            return {
                success: false,
                message: `Unsupported identity method: ${
                    (payload as IdentityPayload).method
                }`,
            }
    }
}
