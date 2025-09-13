import { GithubProofParser } from "./web2/github"
import { TwitterProofParser } from "./web2/twitter"
import { type Web2ProofParser } from "./web2/parsers"
import { Web2CoreTargetIdentityPayload } from "@kynesyslabs/demosdk/abstraction"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { Twitter } from "../identity/tools/twitter"

/**
 * Verifies telegram dual signature attestation (user + bot signatures)
 * 
 * @param payload - The telegram identity payload
 * @param sender - The sender's ed25519 address 
 * @returns Verification result
 */
async function verifyTelegramProof(
    payload: Web2CoreTargetIdentityPayload,
    sender: string,
) {
    try {
        // Parse the telegram attestation from proof field
        const telegramAttestation = JSON.parse(payload.proof)
        
        // TODO: Implement full dual signature validation
        // 1. Verify user signature against payload
        // 2. Verify bot signature against payload
        // 3. Check bot authorization via genesis addresses
        
        // For now, basic validation that it's a proper telegram attestation
        if (!telegramAttestation.payload || !telegramAttestation.signature) {
            return {
                success: false,
                message: "Invalid telegram attestation format",
            }
        }
        
        // Verify the telegram_id and username match
        if (telegramAttestation.payload.telegram_id !== payload.userId ||
            telegramAttestation.payload.username !== payload.username) {
            return {
                success: false,
                message: "Telegram attestation data mismatch",
            }
        }
        
        // TODO: Implement actual signature verification
        // For now, accept all well-formed telegram attestations
        return {
            success: true,
            message: "Telegram proof verified (basic validation)",
        }
        
    } catch (error: any) {
        return {
            success: false,
            message: `Failed to verify telegram proof: ${error.toString()}`,
        }
    }
}

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
        case "telegram":
            // Telegram uses dual signature validation, handle separately
            return await verifyTelegramProof(payload, sender)
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
