import { GithubProofParser } from "./web2/github"
import { XProofParser } from "./web2/twitter"
import { DiscordProofParser } from "./web2/discord"
import { type Web2ProofParser } from "./web2/parsers"
import { Web2CoreTargetIdentityPayload } from "@kynesyslabs/demosdk/abstraction"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { Twitter } from "../identity/tools/twitter"
import type { GenesisBlock } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/blocks" // TODO Properly import from types
import log from "src/utilities/logger"
import {
    TelegramAttestationPayload,
    TelegramSignedAttestation,
} from "@kynesyslabs/demosdk/abstraction"
import { toInteger } from "lodash"
import Chain from "../blockchain/chain"
import fs from "fs"
import { getSharedState } from "@/utilities/sharedState"

/**
 * Verifies telegram dual signature attestation (user + bot signatures)
 *
 * @param payload - The telegram identity payload
 * @param sender - The sender's ed25519 address
 * @returns Verification result
 */
/**
 * Check if a bot address is authorized by verifying it exists in genesis block balances
 * @param botAddress - The bot's address to check
 * @returns Promise<boolean> - true if bot is authorized (has balance in genesis), false otherwise
 */
/**
 * Check if a bot address is authorized by verifying it exists in genesis block balances
 * @param botAddress - The bot's address to check
 * @returns Promise<boolean> - true if bot is authorized (has balance in genesis), false otherwise
 */
async function checkBotAuthorization(botAddress: string): Promise<boolean> {
    if (getSharedState.genesisIdentities.has(botAddress)) {
        return true
    }

    return false
}

async function verifyTelegramProof(
    payload: Web2CoreTargetIdentityPayload,
    sender: string,
) {
    try {
        // Parse the telegram attestation from proof field
        const telegramAttestation = payload.proof as TelegramSignedAttestation
        log.info(
            "telegramAttestation" +
                JSON.stringify(telegramAttestation, null, 2),
        )

        // Validate attestation structure
        if (!telegramAttestation.payload || !telegramAttestation.signature) {
            return {
                success: false,
                message: "Invalid telegram attestation format",
            }
        }

        // REVIEW: Enhanced input validation with type safety and normalization
        // Validate attestation data types first (trusted source should have proper format)
        if (
            typeof telegramAttestation.payload.telegram_user_id !== "number" &&
            typeof telegramAttestation.payload.telegram_user_id !== "string"
        ) {
            return {
                success: false,
                message: "Invalid telegram_id type in bot attestation",
            }
        }

        if (typeof telegramAttestation.payload.username !== "string") {
            return {
                success: false,
                message: "Invalid username type in bot attestation",
            }
        }

        // Safe type conversion and normalization
        const attestationId =
            telegramAttestation.payload.telegram_user_id.toString()
        const payloadId = payload.userId?.toString() || ""

        const attestationUsername = telegramAttestation.payload.username
            .toLowerCase()
            .trim()
        const payloadUsername = payload.username?.toLowerCase()?.trim() || ""

        // Verify the telegram_id and username match with normalized comparison
        if (attestationId !== payloadId) {
            return {
                success: false,
                message: `Telegram ID mismatch: expected ${payloadId}, got ${attestationId}`,
            }
        }

        if (attestationUsername !== payloadUsername) {
            return {
                success: false,
                message: `Telegram username mismatch: expected ${payloadUsername}, got ${attestationUsername}`,
            }
        }

        // Extract the attestation components
        const { payload: attestationPayload, signature } = telegramAttestation
        const { bot_address: botAddress } = attestationPayload

        // INFO: Verify user signature
        const userSignatureValid = await ucrypto.verify({
            algorithm: "ed25519",
            message: new TextEncoder().encode(attestationPayload.challenge),
            publicKey: hexToUint8Array(attestationPayload.public_key),
            signature: hexToUint8Array(attestationPayload.signature),
        })

        if (!userSignatureValid) {
            return {
                success: false,
                message: "User challenge signature verification failed",
            }
        }

        // Prepare the message that was signed (stringify the payload for consistent hashing)
        const messageToVerify = JSON.stringify(attestationPayload)

        // Verify BOT signature against the attestation payload
        // The bot has already verified the user signature locally
        const botSignatureValid = await ucrypto.verify({
            algorithm: signature.type,
            message: new TextEncoder().encode(messageToVerify),
            publicKey: hexToUint8Array(botAddress), // Bot's public key
            signature: hexToUint8Array(signature.data), // Bot signature
        })

        if (!botSignatureValid) {
            return {
                success: false,
                message: "Bot signature verification failed",
            }
        }

        // Check bot authorization - bot must have balance in genesis block
        const botAuthorized = await checkBotAuthorization(botAddress)
        if (!botAuthorized) {
            return {
                success: false,
                message: "Unauthorized bot - not found in genesis addresses",
            }
        }

        return {
            success: true,
            message: "Telegram proof verified successfully",
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
    let parser:
        | typeof XProofParser
        | typeof GithubProofParser
        | typeof DiscordProofParser

    switch (payload.context) {
        case "x":
            parser = XProofParser
            break
        case "github":
            parser = GithubProofParser
            break
        case "telegram":
            // Telegram uses dual signature validation, handle separately
            return await verifyTelegramProof(payload, sender)
        case "discord":
            parser = DiscordProofParser
            break
        default:
            return {
                success: false,
                message: `Unsupported proof context: ${payload.context}`,
            }
    }

    // INFO: Check if X account is a bot
    if (payload.context === "x") {
        const isBot = await Twitter.getInstance().checkIsBot(
            payload.username,
            payload.userId,
        )
        if (isBot === undefined) {
            return {
                success: false,
                message: "Failed to verify X account",
            }
        }

        if (isBot) {
            return {
                success: false,
                message: "You cannot connect this X account",
            }
        }
    }

    const instance = await parser.getInstance()

    // The following contexts will need parsing, so we can assume payload.proof is a string
    try {
        const { message, type, signature } = await instance.readData(
            payload.proof as string,
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
        log.error(error)
        return {
            success: false,
            message: error.toString(),
        }
    }
}

export { XProofParser, Web2ProofParser }
