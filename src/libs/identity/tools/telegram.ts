import * as crypto from "crypto"
import log from "@/utilities/logger"
import Chain from "@/libs/blockchain/chain"
import { 
    TelegramVerificationRequest,
    TelegramVerificationResponse,
    TelegramChallengeResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"
// NOTE: The SDK currently has no exported InferFromTelegramPayload type (compile error showed only Twitter variant).
// Define a minimal local interface mirroring expected web2 identity payload shape for Telegram.
interface TelegramWeb2Payload {
    context: 'telegram'
    proof: string // bot attestation JSON string
    username: string
    userId: string
    attestation_id?: string // Challenge hash for replay attack prevention
}

import { ucrypto, hexToUint8Array } from "@kynesyslabs/demosdk/encryption"

/**
 * Internal challenge storage interface
 */
interface TelegramChallenge {
    challenge: string
    demos_address: string
    timestamp: number
    used: boolean
}

/**
 * Telegram identity verification tool
 * Handles challenge generation, bot authorization, and signature verification
 */
export default class Telegram {
    private static instance: Telegram
    private challenges: Map<string, TelegramChallenge> = new Map()
    private authorizedBots: string[] = []
    private lastGenesisCheck = 0

    private constructor() {
        // Private constructor for singleton pattern
    }

    /**
     * Get the singleton instance of the Telegram tool
     */
    static getInstance(): Telegram {
        if (!Telegram.instance) {
            Telegram.instance = new Telegram()
        }
        return Telegram.instance
    }

    /**
     * Load authorized bot addresses from genesis block
     * Results are cached for 1 hour since genesis never changes
     */
    async getAuthorizedBots(): Promise<string[]> {
        // Cache for 1 hour since genesis never changes
        if (Date.now() - this.lastGenesisCheck < 3600000 && this.authorizedBots.length > 0) {
            return this.authorizedBots
        }

        try {
            const genesisBlock = await Chain.getGenesisBlock()
            if (!genesisBlock || !genesisBlock.content) {
                log.error("Genesis block not found or has no content")
                return []
            }
            // genesisBlock.content is a JSON object (typeorm column json), NOT a string.
            // The original genesis data we need (balances) is embedded as string in content.extra.genesisData.
            let genesisData: any
            if (typeof genesisBlock.content === "string") {
                // (unlikely) stored as string JSON
                genesisData = JSON.parse(genesisBlock.content)
            } else if (
                typeof genesisBlock.content === "object" &&
                genesisBlock.content?.extra?.genesisData
            ) {
                // extra.genesisData is a JSON string created in generateGenesisBlock
                try {
                    genesisData = JSON.parse(genesisBlock.content.extra.genesisData)
                } catch (e) {
                    log.error("Failed to parse embedded genesisData string:" + e)
                    return []
                }
            } else {
                // Fallback: maybe balances directly present
                genesisData = genesisBlock.content
            }
            
            // Extract addresses from balances array
            this.authorizedBots = genesisData.balances?.map((balance: [string, string]) => 
                balance[0].toLowerCase(),
            ) || []
            
            this.lastGenesisCheck = Date.now()
            
            log.info(`Loaded ${this.authorizedBots.length} authorized Telegram bot addresses from genesis`)
            return this.authorizedBots
        } catch (error) {
            log.error("Failed to load authorized bots from genesis:"+ error)
            return []
        }
    }

    /**
     * Check if a bot address is authorized (from genesis block)
     */
    async isAuthorizedBot(botAddress: string): Promise<boolean> {
        const authorizedBots = await this.getAuthorizedBots()
        return authorizedBots.includes(botAddress.toLowerCase())
    }

    /**
     * Generate a challenge for Telegram identity verification
     * Format: DEMOS_TG_BIND_<demos_address>_<timestamp>_<nonce>
     */
    generateChallenge(demosAddress: string): TelegramChallengeResponse {
        const timestamp = Math.floor(Date.now() / 1000)
        const nonce = crypto.randomBytes(16).toString("hex")
        const challenge = `DEMOS_TG_BIND_${demosAddress}_${timestamp}_${nonce}`
        
        // Store challenge for 15 minutes
        this.challenges.set(challenge, {
            challenge,
            demos_address: demosAddress.toLowerCase(),
            timestamp,
            used: false,
        })

        // Auto-cleanup after 15 minutes
        setTimeout(() => {
            this.challenges.delete(challenge)
        }, 15 * 60 * 1000)

        log.info(`Generated Telegram challenge for address ${demosAddress}`)
        
        return { challenge }
    }

    /**
     * Parse a challenge to extract its components
     */
    private parseChallenge(challenge: string): {
        demosAddress: string
        timestamp: number
        nonce: string
    } | null {
        const parts = challenge.split("_")
        // Expected format: DEMOS_TG_BIND_<demos_address>_<timestamp>_<nonce>
        if (parts.length !== 6 || parts[0] !== "DEMOS" || parts[1] !== "TG" || parts[2] !== "BIND") {
            return null
        }
        const demosAddress = parts[3]
        const timestamp = parseInt(parts[4])
        const nonce = parts[5]
        if (isNaN(timestamp)) {
            return null
        }

        return {
            demosAddress,
            timestamp,
            nonce,
        }
    }

    /**
     * Verify a Telegram verification request from a bot
     * This includes both bot signature verification and user signature verification
     */
    /**
     * Verify a Telegram attestation.
     * mode = 'attest'  : interactive phase (bot hits /api/tg-verify). Challenge must exist & be unused; we then mark it used.
     * mode = 'validate': on-chain validation phase (parser replays verification). We verify challenge reuse protection
     *                   by checking the challenge hash embedded in the transaction payload.
     */
    async verifyAttestation(
        request: TelegramVerificationRequest,
        mode: 'attest' | 'validate' = 'attest',
        transactionChallengeHash?: string, // For validate mode: hash from transaction payload
    ): Promise<TelegramVerificationResponse> {
        try {
            // 1. Check if bot address is authorized (from genesis)
            if (!(await this.isAuthorizedBot(request.bot_address))) {
                log.warning(`Unauthorized bot address attempted verification: ${request.bot_address}`)
                return { 
                    success: false, 
                    message: "Unauthorized bot address", 
                }
            }

            // 2. Parse the challenge from user's signed message
            const challengeInput = request.signed_challenge.split(":")[0] || request.signed_challenge

            const challengeData = this.parseChallenge(challengeInput)
            if (!challengeData) {
                return { 
                    success: false, 
                    message: "Invalid challenge format", 
                }
            }

            // 3. Calculate challenge hash for replay protection
            const originalChallenge = `DEMOS_TG_BIND_${challengeData.demosAddress}_${challengeData.timestamp}_${challengeData.nonce}`
            const challengeHash = crypto.createHash('sha256').update(originalChallenge).digest('hex')

            // 4. Validate challenge reuse protection based on mode
            const storedChallenge = this.challenges.get(originalChallenge)
            
            if (mode === 'attest') {
                // Interactive mode: strict challenge validation
                if (!storedChallenge) {
                    return {
                        success: false,
                        message: 'Challenge not found or expired',
                    }
                }
                if (storedChallenge.used) {
                    return {
                        success: false,
                        message: 'Challenge already used',
                    }
                }
            } else if (mode === 'validate') {        
                // If no transaction challenge hash is provided, reject the validation (no legacy txs expected)
                if (!transactionChallengeHash) {
                    return {
                        success: false,
                        message: 'Transaction challenge hash missing - replay protection failed',
                    }
                } else {
                    // Perform full replay protection validation
                    if (challengeHash !== transactionChallengeHash) {
                        return {
                            success: false,
                            message: 'Challenge hash mismatch - potential replay attack detected',
                        }
                    }
                }
            }

            // 5. Verify bot signature
            const attestationData = {
                telegram_id: request.telegram_id,
                username: request.username,
                signed_challenge: request.signed_challenge,
                timestamp: request.timestamp,
            }
            const attestationJson = JSON.stringify(attestationData, Object.keys(attestationData).sort())
            const attestationMessage = new TextEncoder().encode(attestationJson)

            const botSignatureValid = await ucrypto.verify({
                algorithm: "ed25519",
                signature: hexToUint8Array(request.bot_signature),
                publicKey: hexToUint8Array(request.bot_address),
                message: attestationMessage,
            })

            if (!botSignatureValid) {
                log.warning(`Invalid bot signature from ${request.bot_address}`)
                return { 
                    success: false, 
                    message: "Invalid bot signature", 
                }
            }

            // 6. Verify user signature against the original challenge
            const challengeMessage = new TextEncoder().encode(originalChallenge)
            
            // Extract signature from signed challenge (assuming format: "challenge:signature" or just signature)
            const signaturePart = request.signed_challenge.includes(":") 
                ? request.signed_challenge.split(":")[1] 
                : request.signed_challenge

            const userSignatureValid = await ucrypto.verify({
                algorithm: "ed25519",
                signature: hexToUint8Array(signaturePart),
                publicKey: hexToUint8Array(challengeData.demosAddress),
                message: challengeMessage,
            })

            if (!userSignatureValid) {
                log.warning(`Invalid user signature for challenge from ${challengeData.demosAddress}`)
                return { 
                    success: false, 
                    message: "Invalid user signature", 
                }
            }

            // 7. Mark challenge as used only during interactive attestation
            if (storedChallenge && mode === 'attest') {
                storedChallenge.used = true
            }

            // 8. Create unsigned identity transaction with challenge hash for replay protection
            const unsignedTransaction = this.createIdentityTransaction(
                challengeData.demosAddress,
                request.telegram_id,
                request.username,
                JSON.stringify({
                    telegram_id: request.telegram_id,
                    username: request.username,
                    signed_challenge: request.signed_challenge,
                    timestamp: request.timestamp,
                    bot_address: request.bot_address,
                    bot_signature: request.bot_signature,
                }),
                challengeHash, // Add challenge hash to prevent replay attacks
            )

            // 8. Return success with unsigned transaction for user to sign
            log.info(`Successfully verified Telegram identity: ${request.telegram_id} ↔ ${challengeData.demosAddress}`)
            
            return {
                success: true,
                message: "Telegram identity verified. Please sign the transaction to complete binding.",
                demosAddress: challengeData.demosAddress,
                telegramData: {
                    userId: request.telegram_id,
                    username: request.username,
                    timestamp: request.timestamp,
                },
                unsignedTransaction: unsignedTransaction,
            }

        } catch (error) {
            log.error("Error verifying Telegram attestation:" + error)
            return { 
                success: false, 
                message: "Internal verification error", 
            }
        }
    }

    /**
     * Creates an unsigned identity transaction for Telegram verification
     * 
     * This follows the same pattern as Twitter identity transactions:
     * - Transaction type: "identity"
     * - Context: "web2" 
     * - Method: "web2_identity_assign"
     * - Payload contains Telegram identity data and bot attestation proof
     * - Challenge hash embedded for replay attack prevention
     * 
     * @param demosAddress - User's Demos address
     * @param telegramId - Telegram user ID
     * @param username - Telegram username  
     * @param proofData - JSON string containing bot attestation
     * @param challengeHash - SHA256 hash of the original challenge for replay protection
     * @returns Unsigned transaction ready for user signature
     */
    private createIdentityTransaction(
        demosAddress: string,
        telegramId: string,
        username: string,
        proofData: string,
        challengeHash: string,
    ): Transaction {
        const telegramPayload: TelegramWeb2Payload = {
            context: "telegram",
            proof: proofData,  // Bot attestation containing all verification data
            username: username,
            userId: telegramId,
            attestation_id: challengeHash, // Challenge hash for replay attack prevention
        }

        // Create transaction skeleton (same structure as Twitter identity transactions)
        const transaction: Transaction = {
            hash: "", // Will be calculated when signed
            content: {
                type: "identity",
                from_ed25519_address: demosAddress,
                from: demosAddress, // required by TransactionContent
                to: demosAddress, // Identity transactions are self-directed
                amount: 0, // No tokens transferred for identity binding
                transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0 },
                data: [
                    "identity", // Transaction data type identifier
                    {
                        context: "web2", // Web2 identity context
                        method: "web2_identity_assign", // Identity assignment method
                        payload: telegramPayload, // Telegram-specific payload
                    },
                ],
                timestamp: Date.now(),
                nonce: 0, // Will be set by transaction processing
                gcr_edits: [], // Will be generated during transaction validation
            },
            signature: null, // User must sign this
            ed25519_signature: null as any,
            status: "pending" as any,
            blockNumber: 0,
        }

        log.info(`Created unsigned Telegram identity transaction for ${demosAddress} ↔ ${telegramId}`)
        return transaction
    }

    /**
     * Extract challenge hash from a transaction payload
     * Used during validation mode to verify replay protection
     */
    static extractChallengeHashFromTransaction(transaction: Transaction): string | null {
        try {
            if (
                transaction &&
                transaction.content &&
                Array.isArray(transaction.content.data) &&
                transaction.content.data[0] === "identity" &&
                (transaction.content.data[1] as { payload?: TelegramWeb2Payload })?.payload?.attestation_id
            ) {
                return (transaction.content.data[1] as { payload: TelegramWeb2Payload }).payload.attestation_id || null;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Get statistics about current challenges (for debugging/monitoring)
     */
    getChallengeStats(): {
        total: number
        active: number
        used: number
        expired: number
    } {
        const now = Math.floor(Date.now() / 1000)
        let active = 0
        let used = 0
        let expired = 0

        for (const challenge of this.challenges.values()) {
            if (challenge.used) {
                used++
            } else if (now - challenge.timestamp > 900) { // 15 minutes
                expired++
            } else {
                active++
            }
        }

        return {
            total: this.challenges.size,
            active,
            used,
            expired,
        }
    }

    /**
     * Clean up expired challenges (called periodically)
     */
    cleanupExpiredChallenges(): number {
        const now = Math.floor(Date.now() / 1000)
        let cleaned = 0

        for (const [key, challenge] of this.challenges.entries()) {
            if (now - challenge.timestamp > 900) { // 15 minutes
                this.challenges.delete(key)
                cleaned++
            }
        }

        if (cleaned > 0) {
            log.info(`Cleaned up ${cleaned} expired Telegram challenges`)
        }

        return cleaned
    }
}