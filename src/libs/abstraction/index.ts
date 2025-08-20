import { GithubProofParser } from "./web2/github"
import { TwitterProofParser } from "./web2/twitter"
import { TelegramProofParser } from "./web2/telegram"
import { type Web2ProofParser } from "./web2/parsers"
import { Web2CoreTargetIdentityPayload } from "@kynesyslabs/demosdk/abstraction"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { Twitter } from "../identity/tools/twitter"
import { Transaction } from "@kynesyslabs/demosdk/types"

/**
 * Fetches the proof data using the appropriate parser and verifies the signature
 *
 * @param payload - The proof payload
 * @returns true if the proof is valid, false otherwise
 */
/**
 * Verifies Web2 identity proofs (Twitter, GitHub, Telegram)
 * 
 * This function handles the verification of Web2 identity claims by:
 * 1. Selecting the appropriate proof parser based on context
 * 2. Performing context-specific validations (bot detection for Twitter)
 * 3. Extracting and verifying the cryptographic signature
 * 
 * @param payload - Web2 identity payload containing proof data
 * @param sender - The Demos address claiming the identity
 * @returns Verification result with success status and message
 */
export async function verifyWeb2Proof(
    payload: Web2CoreTargetIdentityPayload,
    sender: string,
    transaction?: Transaction,
) {
    let parser: typeof TwitterProofParser | typeof GithubProofParser | typeof TelegramProofParser

    switch (payload.context) {
        case "twitter":
            parser = TwitterProofParser
            break
        case "github":
            parser = GithubProofParser
            break
        case "telegram":
            // REVIEW: Telegram proofs are handled differently - they come from bot attestations
            // rather than user-posted content, but follow the same verification pattern
            parser = TelegramProofParser
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
            payload.context === "telegram" ? transaction : undefined,
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

export { TwitterProofParser, TelegramProofParser, Web2ProofParser }
