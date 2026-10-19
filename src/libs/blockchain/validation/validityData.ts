import { SigningAlgorithm, ValidityData } from "@kynesyslabs/demosdk/types"
import { hexToUint8Array, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import Hashing from "src/libs/crypto/hashing"
import { getSharedState } from "src/utilities/sharedState"
import TxValidatorPool from "./txValidatorPool"

/**
 * The one canonical form of a ValidityData signature: the RPC node signs
 * sha256(JSON.stringify(data)) with its node key. Every signer and
 * verifier goes through here so the digest can never drift between the
 * intake path, the execute path, and gossip ingestion.
 */
export function validityDataDigest(validityData: ValidityData): Uint8Array {
    return new TextEncoder().encode(
        Hashing.sha256(JSON.stringify(validityData.data)),
    )
}

/** Sign `data` with this node's key and attach the signature in place. */
export async function signValidityData(
    validityData: ValidityData,
): Promise<ValidityData> {
    const { signature } = await TxValidatorPool.getInstance().sign(
        getSharedState.signingAlgorithm,
        validityDataDigest(validityData),
    )
    validityData.signature = {
        type: getSharedState.signingAlgorithm,
        data: uint8ArrayToHex(signature),
    }
    validityData.rpc_public_key = {
        type: getSharedState.signingAlgorithm,
        data: getSharedState.publicKeyHex,
    }
    return validityData
}

/** True when `signature` was produced by `rpc_public_key` over `data`. */
export async function verifyValidityDataSignature(
    validityData: ValidityData,
): Promise<boolean> {
    const signature = validityData.signature
    const signer = validityData.rpc_public_key
    if (!signature?.data || !signer?.data) return false
    try {
        return await TxValidatorPool.getInstance().verify({
            algorithm: signature.type as SigningAlgorithm,
            message: validityDataDigest(validityData),
            publicKey: hexToUint8Array(signer.data),
            signature: hexToUint8Array(signature.data),
        })
    } catch {
        return false
    }
}
