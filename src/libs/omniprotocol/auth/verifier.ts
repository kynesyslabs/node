import forge from "node-forge"
import { keccak_256 } from "@noble/hashes/sha3.js"
import {
    AuthBlock,
    SignatureAlgorithm,
    SignatureMode,
    VerificationResult,
} from "./types"
import type { OmniMessageHeader } from "../types/message"
import { ReplayCache } from "./replayCache"
import { timestampedSignedData } from "./signedData"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"

export class SignatureVerifier {
    // Maximum clock skew allowed (5 minutes)
    private static readonly MAX_CLOCK_SKEW = 5 * 60 * 1000

    /**
     * Signature modes whose signed bytes cover the payload, the opcode and
     * the timestamp. Only these may authenticate an auth-required opcode:
     * the others either bind nothing about the payload, so a captured
     * signature authorises any substituted payload (audit C3a), or leave the
     * timestamp unsigned, so a captured frame can be re-dated and replayed
     * for ever.
     */
    private static readonly PAYLOAD_BINDING_MODES: ReadonlySet<SignatureMode> =
        new Set([SignatureMode.SIGN_TIMESTAMPED_PAYLOAD_HASH])

    /** Messages already accepted inside the freshness window. */
    private static readonly replayCache = new ReplayCache(SignatureVerifier.MAX_CLOCK_SKEW)

    /**
     * Verify authentication block against message
     * @param auth Parsed authentication block
     * @param header Message header
     * @param payload Message payload
     * @param requirePayloadBinding When true, reject signature modes that do
     *   not cover the payload. The dispatcher sets this for every
     *   auth-required opcode so the VERIFIER (not the sender) dictates the
     *   minimum binding. Defaults to true — callers must opt OUT explicitly.
     * @returns Verification result
     */
    static async verify(
        auth: AuthBlock,
        header: OmniMessageHeader,
        payload: Buffer,
        requirePayloadBinding = true,
    ): Promise<VerificationResult> {
        // 1. Validate algorithm
        if (!this.isSupportedAlgorithm(auth.algorithm)) {
            return {
                valid: false,
                error: `Unsupported signature algorithm: ${auth.algorithm}`,
            }
        }

        // 1b. Enforce payload-binding on auth-required opcodes. A non-binding
        // mode (e.g. SIGN_PUBKEY) proves key ownership only — its signature is
        // a static, replayable bearer token that says nothing about the
        // opcode/payload, letting a captured value authorise arbitrary
        // messages for that identity. Reject before any further work.
        if (
            requirePayloadBinding &&
            !this.PAYLOAD_BINDING_MODES.has(auth.signatureMode)
        ) {
            return {
                valid: false,
                error: `Signature mode ${auth.signatureMode} does not bind the payload and timestamp; an auth-required opcode requires SIGN_TIMESTAMPED_PAYLOAD_HASH`,
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

        // 2b. The signed bytes name our network; without it we cannot tell
        // a frame from another network apart, so nothing is accepted.
        if (
            auth.signatureMode === SignatureMode.SIGN_TIMESTAMPED_PAYLOAD_HASH &&
            !getSharedState.genesisBlockHash
        ) {
            return {
                valid: false,
                error: "Genesis hash not known yet; cannot verify network-bound auth",
            }
        }

        // 3. Build data to verify based on signature mode
        const dataToVerify = this.buildSignatureData(
            auth.signatureMode,
            auth.identity,
            header,
            payload,
            auth.timestamp,
        )

        // 4. Verify signature
        const signatureValid = await this.verifySignature(
            auth.algorithm,
            auth.identity,
            dataToVerify,
            auth.signature,
        )

        if (!signatureValid) {
            return {
                valid: false,
                error: "Signature verification failed",
            }
        }

        // 5. Derive peer identity from public key
        const peerIdentity = this.derivePeerIdentity(auth.identity)

        // 6. Accept each signed message once. Only modes that sign the
        // timestamp are tracked: for the others a replay can simply be
        // re-dated, so the cache would not stop it.
        if (auth.signatureMode === SignatureMode.SIGN_TIMESTAMPED_PAYLOAD_HASH) {
            const digest = Buffer.from(keccak_256(dataToVerify)).toString("hex")
            if (!this.replayCache.admit(peerIdentity, digest, auth.timestamp)) {
                return {
                    valid: false,
                    error: "Replayed message: already accepted inside the freshness window",
                }
            }
        }

        return {
            valid: true,
            peerIdentity,
        }
    }

    /**
     * Check if algorithm is supported
     */
    private static isSupportedAlgorithm(
        algorithm: SignatureAlgorithm,
    ): boolean {
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
        timestamp: number,
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
                // Sign (Message ID + Keccak256(Payload))
                const msgId = Buffer.allocUnsafe(4)
                msgId.writeUInt32BE(header.sequence)
                const payloadHash = Buffer.from(keccak_256(payload))
                return Buffer.concat([msgId, payloadHash])
            }

            case SignatureMode.SIGN_TIMESTAMPED_PAYLOAD_HASH:
                return timestampedSignedData(
                    getSharedState.genesisBlockHash as string,
                    header.opcode,
                    header.sequence,
                    timestamp,
                    payload,
                )

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
        signature: Buffer,
    ): Promise<boolean> {
        switch (algorithm) {
            case SignatureAlgorithm.ED25519:
                return await this.verifyEd25519(publicKey, data, signature)

            case SignatureAlgorithm.FALCON:
                log.warning(
                    "[SignatureVerifier] Falcon signature verification not yet implemented",
                )
                return false

            case SignatureAlgorithm.ML_DSA:
                log.warning(
                    "[SignatureVerifier] ML-DSA signature verification not yet implemented",
                )
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
        signature: Buffer,
    ): Promise<boolean> {
        try {
            // Validate key and signature lengths
            if (publicKey.length !== 32) {
                log.error(
                    `[SignatureVerifier] Invalid Ed25519 public key length: ${publicKey.length}`,
                )
                return false
            }

            if (signature.length !== 64) {
                log.error(
                    `[SignatureVerifier] Invalid Ed25519 signature length: ${signature.length}`,
                )
                return false
            }

            // Verify using node-forge ed25519 (same as SDK)
            const valid = forge.pki.ed25519.verify({
                message: data,
                signature: signature as forge.pki.ed25519.NativeBuffer,
                publicKey: publicKey as forge.pki.ed25519.NativeBuffer,
            })
            return valid
        } catch (error) {
            log.error(
                "[SignatureVerifier] Ed25519 verification error: " + error,
            )
            return false
        }
    }

    /**
     * Derive peer identity from public key
     * Uses same format as existing HTTP authentication
     */
    private static derivePeerIdentity(publicKey: Buffer): string {
        // REVIEW: For ed25519: identity is 0x-prefixed hex-encoded public key
        // This matches existing Peer.identity format and PeerManager lookup
        return "0x" + publicKey.toString("hex")
    }
}
