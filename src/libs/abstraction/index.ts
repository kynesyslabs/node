import Cryptography from "../crypto/cryptography"
import { GithubProofParser } from "./web2/github"
import { TwitterProofParser } from "./web2/twitter"
import { type Web2ProofParser } from "./web2/parsers"
import { Web2CoreTargetIdentityPayload } from "@kynesyslabs/demosdk/abstraction"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { Twitter } from "../identity/tools/twitter"
import log from "@/utilities/logger"

/**
 * Fetches the proof data using the appropriate parser and verifies the signature
 *
 * @param payload - The proof payload
 * @returns true if the proof is valid, false otherwise
 */
export async function verifyWeb2Proof(
    payload: Web2CoreTargetIdentityPayload,
    sender: string,
) {
    let parser: typeof TwitterProofParser | typeof GithubProofParser

    switch (payload.context) {
        case "twitter":
            parser = TwitterProofParser
            break
        case "github":
            parser = GithubProofParser
            break
        default:
            return {
                success: false,
                message: `Unsupported proof context: ${payload.context}`,
            }
    }

    // INFO: Check if Twitter account is a bot
    if (payload.context === "twitter") {
        const isBot = await Twitter.getInstance().checkIsBot(
            payload.username,
            payload.userId,
        )
        if (isBot === undefined) {
            return {
                success: false,
                message: "Failed to verify Twitter/X account",
            }
        }

        if (isBot) {
            return {
                success: false,
                message: "You cannot connect this Twitter/X account",
            }
        }
    }

    const instance = await parser.getInstance()

    try {
        const { message, type, signature } = await instance.readData(
            payload.proof,
        )
        try {
            const verified = await ucrypto.verify({
                algorithm: type,
                message: new TextEncoder().encode(message),
                publicKey: hexToUint8Array(sender),
                signature: hexToUint8Array(signature),
            })

            return {
                success: verified,
                message: verified
                    ? `Verified ${payload.context} proof`
                    : `Failed to verify ${payload.context} proof`,
            }
        } catch (error: any) {
            return {
                success: false,
                message: `Failed to verify ${
                    payload.context
                } proof: ${error.toString()}`,
            }
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
