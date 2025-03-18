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
    let parser: Web2ProofParser

    switch (payload.context) {
        case "twitter":
            parser = new TwitterProofParser(payload.proof)
            break
        default:
            return false
    }

    const { message, publicKey, signature } = await parser.readData()
    return Cryptography.verify(message, signature, publicKey)
}

export { TwitterProofParser, Web2ProofParser }
