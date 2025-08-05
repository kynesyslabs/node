import { Web2ProofParser } from "./parsers"
import Telegram from "@/libs/identity/tools/telegram"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"

/**
 * TelegramProofParser - Parses and validates Telegram identity proofs
 * 
 * This parser handles the verification of Telegram identity claims by processing
 * bot-attested verifications. Unlike Twitter proofs which are parsed from tweets,
 * Telegram proofs are validated through a challenge-response mechanism with 
 * authorized bot attestation.
 * 
 * Flow:
 * 1. Bot receives signed challenge from user
 * 2. Bot creates attestation with Telegram user data
 * 3. This parser extracts and validates the proof from bot attestation
 * 4. Returns signature data for identity verification
 */
export class TelegramProofParser extends Web2ProofParser {
    private static instance: TelegramProofParser
    telegram: Telegram

    constructor() {
        super()
        this.telegram = Telegram.getInstance()
    }

    /**
     * Reads and validates Telegram identity proof data
     * 
     * For Telegram, the "proof" is the bot's attestation containing:
     * - User's signed challenge
     * - Telegram user data (ID, username)  
     * - Bot's signature of the attestation
     * 
     * @param proofData - JSON string containing bot attestation data
     * @returns Parsed signature data for verification
     */
    async readData(proofData: string): Promise<{
        message: string
        signature: string
        type: SigningAlgorithm
    }> {
        try {
            // REVIEW: For Telegram, the "proof" is actually the bot attestation data
            // Parse the bot attestation containing the user's signed challenge
            const attestationData = JSON.parse(proofData)
            
            // Validate attestation structure
            const requiredFields = ["telegram_id", "username", "signed_challenge", "timestamp", "bot_address", "bot_signature"]
            for (const field of requiredFields) {
                if (!attestationData[field]) {
                    throw new Error(`Missing required field: ${field}`)
                }
            }

            // Verify the bot attestation first (this validates both signatures)
            const verificationResult = await this.telegram.verifyAttestation(attestationData)
            
            if (!verificationResult.success) {
                throw new Error(`Telegram verification failed: ${verificationResult.message}`)
            }

            // Extract the user's signature from the signed challenge
            // The signed_challenge format is: "challenge:signature" or just "signature"
            const signedChallenge = attestationData.signed_challenge
            const signaturePart = signedChallenge.includes(":") 
                ? signedChallenge.split(":")[1] 
                : signedChallenge

            // Extract the original challenge message
            const challengePart = signedChallenge.includes(":")
                ? signedChallenge.split(":")[0]
                : null

            if (!challengePart) {
                throw new Error("Invalid signed challenge format - missing challenge part")
            }

            // REVIEW: Return the signature data in the same format as TwitterProofParser
            // This allows the identity system to verify the user's signature
            return {
                message: challengePart,           // Original challenge that was signed
                signature: signaturePart,        // User's signature of the challenge
                type: "ed25519" as SigningAlgorithm,  // Demos uses ed25519 signatures
            }

        } catch (error) {
            throw new Error(`Failed to parse Telegram proof: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    /**
     * Get singleton instance of TelegramProofParser
     */
    static async getInstance() {
        if (!this.instance) {
            this.instance = new TelegramProofParser()
        }

        return this.instance
    }
}