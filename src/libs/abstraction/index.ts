import { GithubProofParser } from "./web2/github"
import { TwitterProofParser } from "./web2/twitter"
import { type Web2ProofParser } from "./web2/parsers"
import { Web2CoreTargetIdentityPayload } from "@kynesyslabs/demosdk/abstraction"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { Twitter } from "../identity/tools/twitter"
import {
    TelegramAttestationPayload,
    TelegramSignedAttestation,
} from "node_modules/@kynesyslabs/demosdk/build/types/abstraction"

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
async function checkBotAuthorization(botAddress: string): Promise<boolean> {
    try {
        // Import Chain class to access genesis block
        const chainModule = (await import("@/libs/blockchain/chain")).default

        // Get the genesis block (block number 0)
        const genesisBlock = await chainModule.getGenesisBlock()

        if (!genesisBlock || !genesisBlock.content) {
            console.error("Genesis block not found or has no content")
            return false
        }

        // REVIEW It should be ok but if something goes wrong check if the genesis block returned structure is correct
        // NOTE We might want to typize the genesis block return, in case
        // Check if the bot address exists in genesis block balances
        // Genesis block content should contain the initial address balances
        const balances = genesisBlock.content.balances || genesisBlock.content

        // Check if bot address exists in balances (array of [address, balance] tuples)
        if (balances && Array.isArray(balances)) {
            const normalizedBotAddress = botAddress.toLowerCase()

            // Check if address exists in balances array
            for (const balanceEntry of balances) {
                if (Array.isArray(balanceEntry) && balanceEntry.length >= 2) {
                    const [address, balance] = balanceEntry
                    if (
                        typeof address === "string" &&
                        address.toLowerCase() === normalizedBotAddress
                    ) {
                        // Bot found in genesis with non-zero balance - authorized
                        return balance !== "0" && balance !== 0
                    }
                }
            }
        }

        // Bot address not found in genesis balances - unauthorized
        return false
    } catch (error) {
        console.error(`Bot authorization check failed: ${error}`)
        return false
    }
}

async function verifyTelegramProof(
    payload: Web2CoreTargetIdentityPayload,
    sender: string,
) {
    try {
        // Parse the telegram attestation from proof field
        const telegramAttestation = payload.proof as TelegramSignedAttestation

        // Validate attestation structure
        if (!telegramAttestation.payload || !telegramAttestation.signature) {
            return {
                success: false,
                message: "Invalid telegram attestation format",
            }
        }

        // Verify the telegram_id and username match
        if (
            telegramAttestation.payload.telegram_id !== payload.userId ||
            telegramAttestation.payload.username !== payload.username
        ) {
            return {
                success: false,
                message: "Telegram attestation data mismatch",
            }
        }

        // Extract the attestation components
        const { payload: attestationPayload, signature } = telegramAttestation
        const { public_key: userPublicKey, bot_address: botAddress } =
            attestationPayload

        // Verify that the user's public key matches the sender
        // This ensures the transaction sender owns the telegram identity
        if (userPublicKey.toLowerCase() !== sender.toLowerCase()) {
            return {
                success: false,
                message:
                    "Telegram attestation public key does not match transaction sender",
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
        console.error(error)
        return {
            success: false,
            message: error.toString(),
        }
    }
}

export { TwitterProofParser, Web2ProofParser }
