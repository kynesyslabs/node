export enum SignatureAlgorithm {
    NONE = 0x00,
    ED25519 = 0x01,
    FALCON = 0x02,
    ML_DSA = 0x03,
}

export enum SignatureMode {
    SIGN_PUBKEY = 0x01, // Sign public key only (HTTP compat)
    SIGN_MESSAGE_ID = 0x02, // Sign Message ID only
    SIGN_FULL_PAYLOAD = 0x03, // Sign full payload
    SIGN_MESSAGE_ID_PAYLOAD_HASH = 0x04, // Sign (Message ID + Payload hash)
    SIGN_MESSAGE_ID_TIMESTAMP = 0x05, // Sign (Message ID + Timestamp)
}

export interface AuthBlock {
    algorithm: SignatureAlgorithm
    signatureMode: SignatureMode
    timestamp: number // Unix timestamp (milliseconds)
    identity: Buffer // Public key bytes
    signature: Buffer // Signature bytes
}

export interface VerificationResult {
    valid: boolean
    error?: string
    peerIdentity?: string
}
