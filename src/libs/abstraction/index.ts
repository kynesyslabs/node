import { TwitterProofParser } from "./web2/twitter"
import { DiscordProofParser } from "./web2/discord"
import { type Web2ProofParser } from "./web2/parsers"
import { Web2CoreTargetIdentityPayload } from "@kynesyslabs/demosdk/abstraction"
import { Hashing, hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { Twitter } from "../identity/tools/twitter"
import log from "src/utilities/logger"
import { TelegramSignedAttestation } from "@kynesyslabs/demosdk/abstraction"
import { getSharedState } from "@/utilities/sharedState"

// Generic OAuth attestation type that works for any provider
interface SignedOAuthAttestation {
    attestation: {
        provider: string
        userId: string
        username: string
        timestamp: number
        nodePublicKey: string
    }
    signature: string
    signatureType: string
}

function canonicalJSON(obj: Record<string, unknown>): string {
    const sortedObj: Record<string, unknown> = {}
    Object.keys(obj).sort((a, b) => a.localeCompare(b)).forEach(key => {
        sortedObj[key] = obj[key]
    })
    return JSON.stringify(sortedObj)
}

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

/**
 * Generic OAuth attestation verification for any provider (GitHub, Discord, etc.)
 *
 * @param payload - The web2 identity payload containing proof and user info
 * @param provider - The OAuth provider name (e.g., "github", "discord")
 * @returns Verification result with success status and message
 */
async function verifySignedOAuthAttestation(
    payload: Web2CoreTargetIdentityPayload,
    provider: string,
): Promise<{ success: boolean; message: string }> {
    try {
        let signedAttestation: SignedOAuthAttestation

        // Parse the proof - it could be a string or already an object
        if (typeof payload.proof === "string") {
            signedAttestation = JSON.parse(payload.proof)
        } else {
            signedAttestation = payload.proof as unknown as SignedOAuthAttestation
        }

        // Validate attestation structure
        if (
            !signedAttestation?.attestation ||
            !signedAttestation?.signature ||
            !signedAttestation?.signatureType
        ) {
            return {
                success: false,
                message: `Invalid ${provider} OAuth attestation structure`,
            }
        }

        const { attestation, signature, signatureType } = signedAttestation

        // Verify attestation data matches payload
        if (attestation.provider !== provider) {
            return {
                success: false,
                message: `Invalid provider in attestation: expected ${provider}, got ${attestation.provider}`,
            }
        }

        if (attestation.userId !== payload.userId) {
            return {
                success: false,
                message: `User ID mismatch: expected ${payload.userId}, got ${attestation.userId}`,
            }
        }

        if (attestation.username !== payload.username) {
            return {
                success: false,
                message: `Username mismatch: expected ${payload.username}, got ${attestation.username}`,
            }
        }

        // Check attestation is not too old (5 minutes)
        const maxAge = 5 * 60 * 1000
        if (Date.now() - attestation.timestamp > maxAge) {
            return {
                success: false,
                message: `${provider} OAuth attestation has expired`,
            }
        }

        // Validate signature algorithm
        const allowedAlgorithms = ["ed25519", "ml-dsa", "falcon"] as const
        if (!allowedAlgorithms.includes(signatureType as typeof allowedAlgorithms[number])) {
            return {
                success: false,
                message: `Unsupported signature algorithm: ${signatureType}`,
            }
        }

        // Verify the signature using canonical JSON for deterministic hashing
        const attestationString = canonicalJSON(attestation as unknown as Record<string, unknown>)
        const hash = Hashing.sha256(attestationString)

        const nodePublicKeyHex = attestation.nodePublicKey.replace("0x", "")
        const publicKeyBytes = hexToUint8Array(nodePublicKeyHex)
        const signatureBytes = hexToUint8Array(signature)

        const isValid = await ucrypto.verify({
            algorithm: signatureType as typeof allowedAlgorithms[number],
            message: new TextEncoder().encode(hash),
            signature: signatureBytes,
            publicKey: publicKeyBytes,
        })

        if (!isValid) {
            return {
                success: false,
                message: `Invalid ${provider} OAuth attestation signature`,
            }
        }

        // Check that the signing node is authorized (exists in genesis identities)
        const nodeAddress = attestation.nodePublicKey.replace("0x", "")
        const ownPublicKey = getSharedState.publicKeyHex?.replace("0x", "")
        const isOwnNode = nodeAddress === ownPublicKey

        const nodeAuthorized = isOwnNode || await checkBotAuthorization(nodeAddress)
        if (!nodeAuthorized) {
            return {
                success: false,
                message: "Unauthorized node - not found in genesis addresses",
            }
        }

        log.info(
            `${provider} OAuth attestation verified: userId=${payload.userId}, username=${payload.username}`,
        )

        return {
            success: true,
            message: `Verified ${provider} OAuth attestation`,
        }
    } catch (error) {
        log.error(`${provider} OAuth attestation verification error: ${error}`)
        return {
            success: false,
            message: `${provider} OAuth attestation verification failed: ${error instanceof Error ? error.message : String(error)}`,
        }
    }
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
        | typeof TwitterProofParser
        | typeof DiscordProofParser

    // Handle OAuth-based proofs with signed attestation (GitHub, Discord, etc.)
    // Check if proof is a JSON object (OAuth attestation) vs URL string (legacy proof)
    // OAuth proof can be: 1) a string starting with "{", 2) an object with attestation property
    const oauthProviders = ["github", "discord"]
    const isStringProof = typeof payload.proof === "string"
    const isOAuthStringProof = isStringProof && (payload.proof as string).trim().startsWith("{")
    const isOAuthObjectProof = !isStringProof &&
        typeof payload.proof === "object" &&
        payload.proof !== null &&
        "attestation" in payload.proof

    if (oauthProviders.includes(payload.context) && (isOAuthStringProof || isOAuthObjectProof)) {
        return await verifySignedOAuthAttestation(payload, payload.context)
    }

    switch (payload.context) {
        case "twitter":
            parser = TwitterProofParser
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
                message: `Failed to verify ${payload.context
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
