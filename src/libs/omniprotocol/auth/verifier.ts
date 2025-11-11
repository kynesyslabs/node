import * as ed25519 from "@noble/ed25519"
import { sha256 } from "@noble/hashes/sha256"
import { AuthBlock, SignatureAlgorithm, SignatureMode, VerificationResult } from "./types"
import type { OmniMessageHeader } from "../types/message"

export class SignatureVerifier {
    // Maximum clock skew allowed (5 minutes)
    private static readonly MAX_CLOCK_SKEW = 5 * 60 * 1000

    /**
     * Verify authentication block against message
     * @param auth Parsed authentication block
     * @param header Message header
     * @param payload Message payload
     * @returns Verification result
     */
    static async verify(
        auth: AuthBlock,
        header: OmniMessageHeader,
        payload: Buffer
    ): Promise<VerificationResult> {
        // 1. Validate algorithm
        if (!this.isSupportedAlgorithm(auth.algorithm)) {
            return {
                valid: false,
                error: `Unsupported signature algorithm: ${auth.algorithm}`,
            }
        }

        // 2. Validate timestamp (replay protection)
        const timestampValid = this.validateTimestamp(auth.timestamp)
        if (!timestampValid) {
            return {
                valid: false,
                error: `Timestamp outside acceptable window: ${auth.timestamp} (now: ${Date.now()})`,
            }
        }

        // 3. Build data to verify based on signature mode
        const dataToVerify = this.buildSignatureData(
            auth.signatureMode,
            auth.identity,
            header,
            payload,
            auth.timestamp
        )

        // 4. Verify signature
        const signatureValid = await this.verifySignature(
            auth.algorithm,
            auth.identity,
            dataToVerify,
            auth.signature
        )

        if (!signatureValid) {
            return {
                valid: false,
                error: "Signature verification failed",
            }
        }

        // 5. Derive peer identity from public key
        const peerIdentity = this.derivePeerIdentity(auth.identity)

        return {
            valid: true,
            peerIdentity,
        }
    }

    /**
     * Check if algorithm is supported
     */
    private static isSupportedAlgorithm(algorithm: SignatureAlgorithm): boolean {
        // Currently only Ed25519 is fully implemented
        return algorithm === SignatureAlgorithm.ED25519
    }

    /**
     * Validate timestamp (replay protection)
     * Reject messages with timestamps outside ±5 minutes
     */
    private static validateTimestamp(timestamp: number): boolean {
        const now = Date.now()
        const diff = Math.abs(now - timestamp)
        return diff <= this.MAX_CLOCK_SKEW
    }

    /**
     * Build data to sign based on signature mode
     */
    private static buildSignatureData(
        mode: SignatureMode,
        identity: Buffer,
        header: OmniMessageHeader,
        payload: Buffer,
        timestamp: number
    ): Buffer {
        switch (mode) {
            case SignatureMode.SIGN_PUBKEY:
                // Sign public key only (HTTP compatibility)
                return identity

            case SignatureMode.SIGN_MESSAGE_ID: {
                // Sign message ID only
                const msgIdBuf = Buffer.allocUnsafe(4)
                msgIdBuf.writeUInt32BE(header.sequence)
                return msgIdBuf
            }

            case SignatureMode.SIGN_FULL_PAYLOAD:
                // Sign full payload
                return payload

            case SignatureMode.SIGN_MESSAGE_ID_PAYLOAD_HASH: {
                // Sign (Message ID + SHA256(Payload))
                const msgId = Buffer.allocUnsafe(4)
                msgId.writeUInt32BE(header.sequence)
                const payloadHash = Buffer.from(sha256(payload))
                return Buffer.concat([msgId, payloadHash])
            }

            case SignatureMode.SIGN_MESSAGE_ID_TIMESTAMP: {
                // Sign (Message ID + Timestamp)
                const msgId = Buffer.allocUnsafe(4)
                msgId.writeUInt32BE(header.sequence)
                const tsBuf = Buffer.allocUnsafe(8)
                tsBuf.writeBigUInt64BE(BigInt(timestamp))
                return Buffer.concat([msgId, tsBuf])
            }

            default:
                throw new Error(`Unsupported signature mode: ${mode}`)
        }
    }

    /**
     * Verify cryptographic signature
     */
    private static async verifySignature(
        algorithm: SignatureAlgorithm,
        publicKey: Buffer,
        data: Buffer,
        signature: Buffer
    ): Promise<boolean> {
        switch (algorithm) {
            case SignatureAlgorithm.ED25519:
                return await this.verifyEd25519(publicKey, data, signature)

            case SignatureAlgorithm.FALCON:
                console.warn("Falcon signature verification not yet implemented")
                return false

            case SignatureAlgorithm.ML_DSA:
                console.warn("ML-DSA signature verification not yet implemented")
                return false

            default:
                throw new Error(`Unsupported algorithm: ${algorithm}`)
        }
    }

    /**
     * Verify Ed25519 signature
     */
    private static async verifyEd25519(
        publicKey: Buffer,
        data: Buffer,
        signature: Buffer
    ): Promise<boolean> {
        try {
            // Validate key and signature lengths
            if (publicKey.length !== 32) {
                console.error(`Invalid Ed25519 public key length: ${publicKey.length}`)
                return false
            }

            if (signature.length !== 64) {
                console.error(`Invalid Ed25519 signature length: ${signature.length}`)
                return false
            }

            // Verify using noble/ed25519
            const valid = await ed25519.verify(signature, data, publicKey)
            return valid
        } catch (error) {
            console.error("Ed25519 verification error:", error)
            return false
        }
    }

    /**
     * Derive peer identity from public key
     * Uses same format as existing HTTP authentication
     */
    private static derivePeerIdentity(publicKey: Buffer): string {
        // For ed25519: identity is hex-encoded public key
        // This matches existing Peer.identity format
        return publicKey.toString("hex")
    }
}
