import { Web2CoreTargetIdentityPayload } from "@kynesyslabs/demosdk/abstraction"
import Cryptography from "../crypto/cryptography"
import { TwitterProofParser, Web2ProofParser } from "./web2/parsers"

/**
 * Fetches the proof data using the appropriate parser and verifies the signature
 *
 * @param payload - The proof payload
 * @returns true if the proof is valid, false otherwise
 */
export async function verifyWeb2Proof(payload: Web2CoreTargetIdentityPayload) {
    let parser: typeof Web2ProofParser

    switch (payload.context) {
        case "twitter":
            parser = TwitterProofParser
            break
        default:
            return {
                success: false,
                message: `Unsupported proof context: ${payload.context}`,
            }
    }

    const instance = await parser.getInstance()

    try {
        const { message, publicKey, signature } = await instance.readData(
            payload.proof,
        )
        const verified = Cryptography.verify(message, signature, publicKey)

        return {
            success: verified,
            message: `Verified ${payload.context} proof`,
        }
    } catch (error: any) {
        console.error(error)
        return {
            success: false,
            message: error.toString(),
        }
    }
}

export { TwitterProofParser, Web2ProofParser }
