# OmniProtocol - Step 9: Authentication Implementation

**Status**: 🚧 CRITICAL - Required for Production Security
**Priority**: P0 - Blocks secure communication
**Dependencies**: Steps 1-2 (Message Format, Opcode Mapping), Crypto libraries

---

## 1. Overview

Authentication is currently **stubbed out** in the implementation (see PeerConnection.ts:95). This document specifies complete authentication block parsing, signature verification, and identity management.

### Security Goals

✅ **Identity Verification**: Prove peer controls claimed public key
✅ **Replay Protection**: Prevent message replay attacks via timestamps
✅ **Integrity**: Ensure messages haven't been tampered with
✅ **Algorithm Agility**: Support multiple signature algorithms
✅ **Performance**: Fast validation (<5ms per message)

---

## 2. Authentication Block Format

From Step 1 specification, authentication block is present when **Flags bit 0 = 1**:

```
┌───────────┬────────────┬───────────┬─────────┬──────────┬─────────┬───────────┐
│ Algorithm │ Sig Mode   │ Timestamp │ ID Len  │ Identity │ Sig Len │ Signature │
│  1 byte   │  1 byte    │  8 bytes  │ 2 bytes │ variable │ 2 bytes │ variable  │
└───────────┴────────────┴───────────┴─────────┴──────────┴─────────┴───────────┘
```

### Field Details

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| Algorithm | uint8 | 0x01=ed25519, 0x02=falcon, 0x03=ml-dsa | Must be supported algorithm |
| Signature Mode | uint8 | 0x01-0x05 (what data is signed) | Must be valid mode for opcode |
| Timestamp | uint64 | Unix timestamp (milliseconds) | Must be within ±5 minutes |
| Identity Length | uint16 | Public key length in bytes | Must match algorithm |
| Identity | bytes | Public key (raw binary) | Algorithm-specific validation |
| Signature Length | uint16 | Signature length in bytes | Must match algorithm |
| Signature | bytes | Signature (raw binary) | Cryptographic verification |

---

## 3. Core Components

### 3.1 Authentication Block Parser

```typescript
import { PrimitiveDecoder } from "../serialization/primitives"

export enum SignatureAlgorithm {
    NONE = 0x00,
    ED25519 = 0x01,
    FALCON = 0x02,
    ML_DSA = 0x03,
}

export enum SignatureMode {
    SIGN_PUBKEY = 0x01,             // Sign public key only (HTTP compat)
    SIGN_MESSAGE_ID = 0x02,         // Sign Message ID only
    SIGN_FULL_PAYLOAD = 0x03,       // Sign full payload
    SIGN_MESSAGE_ID_PAYLOAD_HASH = 0x04,  // Sign (Message ID + Payload hash)
    SIGN_MESSAGE_ID_TIMESTAMP = 0x05,     // Sign (Message ID + Timestamp)
}

export interface AuthBlock {
    algorithm: SignatureAlgorithm
    signatureMode: SignatureMode
    timestamp: number                // Unix timestamp (milliseconds)
    identity: Buffer                 // Public key bytes
    signature: Buffer                // Signature bytes
}

export class AuthBlockParser {
    /**
     * Parse authentication block from buffer
     * @param buffer Message buffer starting at auth block
     * @param offset Offset into buffer where auth block starts
     * @returns Parsed auth block and bytes consumed
     */
    static parse(buffer: Buffer, offset: number): { auth: AuthBlock; bytesRead: number } {
        let pos = offset

        // Algorithm (1 byte)
        const { value: algorithm, bytesRead: algBytes } = PrimitiveDecoder.decodeUInt8(
            buffer,
            pos
        )
        pos += algBytes

        // Signature Mode (1 byte)
        const { value: signatureMode, bytesRead: modeBytes } = PrimitiveDecoder.decodeUInt8(
            buffer,
            pos
        )
        pos += modeBytes

        // Timestamp (8 bytes)
        const { value: timestamp, bytesRead: tsBytes } = PrimitiveDecoder.decodeUInt64(
            buffer,
            pos
        )
        pos += tsBytes

        // Identity Length (2 bytes)
        const { value: identityLength, bytesRead: idLenBytes } =
            PrimitiveDecoder.decodeUInt16(buffer, pos)
        pos += idLenBytes

        // Identity (variable)
        const identity = buffer.subarray(pos, pos + identityLength)
        pos += identityLength

        // Signature Length (2 bytes)
        const { value: signatureLength, bytesRead: sigLenBytes } =
            PrimitiveDecoder.decodeUInt16(buffer, pos)
        pos += sigLenBytes

        // Signature (variable)
        const signature = buffer.subarray(pos, pos + signatureLength)
        pos += signatureLength

        return {
            auth: {
                algorithm: algorithm as SignatureAlgorithm,
                signatureMode: signatureMode as SignatureMode,
                timestamp,
                identity,
                signature,
            },
            bytesRead: pos - offset,
        }
    }

    /**
     * Encode authentication block to buffer
     */
    static encode(auth: AuthBlock): Buffer {
        const parts: Buffer[] = []

        // Algorithm (1 byte)
        parts.push(Buffer.from([auth.algorithm]))

        // Signature Mode (1 byte)
        parts.push(Buffer.from([auth.signatureMode]))

        // Timestamp (8 bytes)
        const tsBuffer = Buffer.allocUnsafe(8)
        tsBuffer.writeBigUInt64BE(BigInt(auth.timestamp))
        parts.push(tsBuffer)

        // Identity Length (2 bytes)
        const idLenBuffer = Buffer.allocUnsafe(2)
        idLenBuffer.writeUInt16BE(auth.identity.length)
        parts.push(idLenBuffer)

        // Identity (variable)
        parts.push(auth.identity)

        // Signature Length (2 bytes)
        const sigLenBuffer = Buffer.allocUnsafe(2)
        sigLenBuffer.writeUInt16BE(auth.signature.length)
        parts.push(sigLenBuffer)

        // Signature (variable)
        parts.push(auth.signature)

        return Buffer.concat(parts)
    }
}
```

### 3.2 Signature Verifier

```typescript
import * as ed25519 from "@noble/ed25519"
import { sha256 } from "@noble/hashes/sha256"

export interface VerificationResult {
    valid: boolean
    error?: string
    peerIdentity?: string
}

export class SignatureVerifier {
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
                error: `Timestamp outside acceptable window: ${auth.timestamp}`,
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
        return [
            SignatureAlgorithm.ED25519,
            SignatureAlgorithm.FALCON,
            SignatureAlgorithm.ML_DSA,
        ].includes(algorithm)
    }

    /**
     * Validate timestamp (replay protection)
     * Reject messages with timestamps outside ±5 minutes
     */
    private static validateTimestamp(timestamp: number): boolean {
        const now = Date.now()
        const diff = Math.abs(now - timestamp)
        const MAX_CLOCK_SKEW = 5 * 60 * 1000 // 5 minutes

        return diff <= MAX_CLOCK_SKEW
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

            case SignatureMode.SIGN_MESSAGE_ID:
                // Sign message ID only
                const msgIdBuf = Buffer.allocUnsafe(4)
                msgIdBuf.writeUInt32BE(header.sequence)
                return msgIdBuf

            case SignatureMode.SIGN_FULL_PAYLOAD:
                // Sign full payload
                return payload

            case SignatureMode.SIGN_MESSAGE_ID_PAYLOAD_HASH:
                // Sign (Message ID + SHA256(Payload))
                const msgId = Buffer.allocUnsafe(4)
                msgId.writeUInt32BE(header.sequence)
                const payloadHash = Buffer.from(sha256(payload))
                return Buffer.concat([msgId, payloadHash])

            case SignatureMode.SIGN_MESSAGE_ID_TIMESTAMP:
                // Sign (Message ID + Timestamp)
                const msgId2 = Buffer.allocUnsafe(4)
                msgId2.writeUInt32BE(header.sequence)
                const tsBuf = Buffer.allocUnsafe(8)
                tsBuf.writeBigUInt64BE(BigInt(timestamp))
                return Buffer.concat([msgId2, tsBuf])

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
                return await this.verifyFalcon(publicKey, data, signature)

            case SignatureAlgorithm.ML_DSA:
                return await this.verifyMLDSA(publicKey, data, signature)

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
     * Verify Falcon signature (post-quantum)
     * NOTE: Requires falcon library integration
     */
    private static async verifyFalcon(
        publicKey: Buffer,
        data: Buffer,
        signature: Buffer
    ): Promise<boolean> {
        // TODO: Integrate Falcon library (e.g., pqcrypto or falcon-crypto)
        // For now, return false to prevent using unimplemented algorithm
        console.warn("Falcon signature verification not yet implemented")
        return false
    }

    /**
     * Verify ML-DSA signature (post-quantum)
     * NOTE: Requires ML-DSA library integration
     */
    private static async verifyMLDSA(
        publicKey: Buffer,
        data: Buffer,
        signature: Buffer
    ): Promise<boolean> {
        // TODO: Integrate ML-DSA library (e.g., ml-dsa from NIST PQC)
        // For now, return false to prevent using unimplemented algorithm
        console.warn("ML-DSA signature verification not yet implemented")
        return false
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
```

### 3.3 Message Parser with Auth

Update MessageFramer to extract auth block:

```typescript
export interface ParsedOmniMessage<TPayload = Buffer> {
    header: OmniMessageHeader
    auth: AuthBlock | null           // Present if Flags bit 0 = 1
    payload: TPayload
}

export class MessageFramer {
    /**
     * Extract complete message with auth block parsing
     */
    extractMessage(): ParsedOmniMessage | null {
        // Parse header first (existing code)
        const header = this.parseHeader()
        if (!header) return null

        // Check if we have complete message
        const authBlockSize = this.isAuthRequired(header) ? this.estimateAuthSize() : 0
        const totalSize = HEADER_SIZE + authBlockSize + header.payloadLength + CHECKSUM_SIZE

        if (this.buffer.length < totalSize) {
            return null // Need more data
        }

        let offset = HEADER_SIZE

        // Parse auth block if present
        let auth: AuthBlock | null = null
        if (this.isAuthRequired(header)) {
            const authResult = AuthBlockParser.parse(this.buffer, offset)
            auth = authResult.auth
            offset += authResult.bytesRead
        }

        // Extract payload
        const payload = this.buffer.subarray(offset, offset + header.payloadLength)
        offset += header.payloadLength

        // Validate checksum
        const checksum = this.buffer.readUInt32BE(offset)
        if (!this.validateChecksum(this.buffer.subarray(0, offset), checksum)) {
            throw new Error("Checksum validation failed")
        }

        // Consume message from buffer
        this.buffer = this.buffer.subarray(offset + CHECKSUM_SIZE)

        return {
            header,
            auth,
            payload,
        }
    }

    /**
     * Check if auth is required based on Flags bit 0
     */
    private isAuthRequired(header: OmniMessageHeader): boolean {
        // Flags is byte at offset 3 in header
        const flags = this.buffer[3]
        return (flags & 0x01) === 0x01 // Check bit 0
    }

    /**
     * Estimate auth block size for buffer checking
     * Assumes typical ed25519 (32-byte key + 64-byte sig)
     */
    private estimateAuthSize(): number {
        // Worst case: 1 + 1 + 8 + 2 + 256 + 2 + 1024 = ~1294 bytes (post-quantum)
        // Typical case: 1 + 1 + 8 + 2 + 32 + 2 + 64 = 110 bytes (ed25519)
        return 110
    }
}
```

### 3.4 Authentication Middleware

Integrate verification into message dispatch:

```typescript
export async function dispatchOmniMessage<TPayload = unknown>(
    options: DispatchOptions<TPayload>
): Promise<Buffer> {
    const opcode = options.message.header.opcode as OmniOpcode
    const descriptor = getHandler(opcode)

    if (!descriptor) {
        throw new UnknownOpcodeError(opcode)
    }

    // Check if handler requires authentication
    if (descriptor.authRequired) {
        // Verify auth block is present
        if (!options.message.auth) {
            throw new OmniProtocolError(
                `Authentication required for opcode ${descriptor.name}`,
                0xf401 // Unauthorized
            )
        }

        // Verify signature
        const verificationResult = await SignatureVerifier.verify(
            options.message.auth,
            options.message.header,
            options.message.payload as Buffer
        )

        if (!verificationResult.valid) {
            throw new OmniProtocolError(
                `Authentication failed: ${verificationResult.error}`,
                0xf401 // Unauthorized
            )
        }

        // Update context with verified identity
        options.context.peerIdentity = verificationResult.peerIdentity!
        options.context.isAuthenticated = true
    }

    // Call handler
    const handlerContext: HandlerContext<TPayload> = {
        message: options.message,
        context: options.context,
        fallbackToHttp: options.fallbackToHttp,
    }

    try {
        return await descriptor.handler(handlerContext)
    } catch (error) {
        if (error instanceof OmniProtocolError) {
            throw error
        }

        throw new OmniProtocolError(
            `Handler for opcode ${descriptor.name} failed: ${String(error)}`,
            0xf001
        )
    }
}
```

---

## 4. Client-Side Signing

Update PeerConnection to include auth block when sending:

```typescript
export class PeerConnection {
    /**
     * Send authenticated message
     */
    async sendAuthenticated(
        opcode: number,
        payload: Buffer,
        privateKey: Buffer,
        publicKey: Buffer,
        timeout: number
    ): Promise<Buffer> {
        const sequence = this.nextSequence++
        const timestamp = Date.now()

        // Build auth block
        const auth: AuthBlock = {
            algorithm: SignatureAlgorithm.ED25519,
            signatureMode: SignatureMode.SIGN_MESSAGE_ID_PAYLOAD_HASH,
            timestamp,
            identity: publicKey,
            signature: Buffer.alloc(0), // Will be filled below
        }

        // Build data to sign
        const msgIdBuf = Buffer.allocUnsafe(4)
        msgIdBuf.writeUInt32BE(sequence)
        const payloadHash = Buffer.from(sha256(payload))
        const dataToSign = Buffer.concat([msgIdBuf, payloadHash])

        // Sign with Ed25519
        const signature = await ed25519.sign(dataToSign, privateKey)
        auth.signature = Buffer.from(signature)

        // Encode header with auth flag
        const header: OmniMessageHeader = {
            version: 1,
            opcode,
            sequence,
            payloadLength: payload.length,
        }

        // Set Flags bit 0 (auth required)
        const flags = 0x01

        // Encode message with auth block
        const messageBuffer = this.encodeAuthenticatedMessage(header, auth, payload, flags)

        // Send and await response
        this.socket!.write(messageBuffer)
        return await this.awaitResponse(sequence, timeout)
    }

    /**
     * Encode message with authentication block
     */
    private encodeAuthenticatedMessage(
        header: OmniMessageHeader,
        auth: AuthBlock,
        payload: Buffer,
        flags: number
    ): Buffer {
        // Encode header (12 bytes)
        const versionBuf = PrimitiveEncoder.encodeUInt16(header.version)
        const opcodeBuf = PrimitiveEncoder.encodeUInt8(header.opcode)
        const flagsBuf = PrimitiveEncoder.encodeUInt8(flags)
        const lengthBuf = PrimitiveEncoder.encodeUInt32(payload.length)
        const sequenceBuf = PrimitiveEncoder.encodeUInt32(header.sequence)

        const headerBuf = Buffer.concat([
            versionBuf,
            opcodeBuf,
            flagsBuf,
            lengthBuf,
            sequenceBuf,
        ])

        // Encode auth block
        const authBuf = AuthBlockParser.encode(auth)

        // Calculate checksum over header + auth + payload
        const dataToCheck = Buffer.concat([headerBuf, authBuf, payload])
        const checksum = crc32(dataToCheck)
        const checksumBuf = PrimitiveEncoder.encodeUInt32(checksum)

        // Return complete message
        return Buffer.concat([headerBuf, authBuf, payload, checksumBuf])
    }
}
```

---

## 5. Integration with Existing Auth System

The node already has key management for HTTP authentication. Reuse this:

```typescript
// Import existing key management
import { getNodePrivateKey, getNodePublicKey } from "../crypto/keys"

export class AuthenticatedPeerConnection extends PeerConnection {
    /**
     * Send message with automatic signing using node's keys
     */
    async sendWithAuth(
        opcode: number,
        payload: Buffer,
        timeout: number = 30000
    ): Promise<Buffer> {
        // Get node's Ed25519 keys
        const privateKey = getNodePrivateKey()
        const publicKey = getNodePublicKey()

        // Send authenticated message
        return await this.sendAuthenticated(
            opcode,
            payload,
            privateKey,
            publicKey,
            timeout
        )
    }
}
```

---

## 6. Security Best Practices

### 6.1 Timestamp Validation

```typescript
// Reject messages with timestamps too far in past/future
const MAX_CLOCK_SKEW = 5 * 60 * 1000 // 5 minutes

function validateTimestamp(timestamp: number): boolean {
    const now = Date.now()
    const diff = Math.abs(now - timestamp)
    return diff <= MAX_CLOCK_SKEW
}
```

### 6.2 Nonce Tracking (Optional)

For ultra-high security, track used nonces to prevent replay within time window:

```typescript
class NonceCache {
    private cache: Set<string> = new Set()
    private readonly maxSize = 10000

    add(nonce: string): void {
        if (this.cache.size >= this.maxSize) {
            // Clear old nonces (oldest first)
            const first = this.cache.values().next().value
            this.cache.delete(first)
        }
        this.cache.add(nonce)
    }

    has(nonce: string): boolean {
        return this.cache.has(nonce)
    }
}
```

### 6.3 Rate Limiting by Identity

```typescript
class AuthRateLimiter {
    private attempts: Map<string, number[]> = new Map()
    private readonly windowMs = 60000 // 1 minute
    private readonly maxAttempts = 10

    isAllowed(peerIdentity: string): boolean {
        const now = Date.now()
        const attempts = this.attempts.get(peerIdentity) || []

        // Remove old attempts
        const recent = attempts.filter(time => now - time < this.windowMs)

        if (recent.length >= this.maxAttempts) {
            return false
        }

        recent.push(now)
        this.attempts.set(peerIdentity, recent)
        return true
    }
}
```

---

## 7. Testing

### 7.1 Unit Tests

```typescript
describe("SignatureVerifier", () => {
    it("should verify valid Ed25519 signature", async () => {
        const privateKey = ed25519.utils.randomPrivateKey()
        const publicKey = await ed25519.getPublicKey(privateKey)

        const data = Buffer.from("test message")
        const signature = await ed25519.sign(data, privateKey)

        const auth: AuthBlock = {
            algorithm: SignatureAlgorithm.ED25519,
            signatureMode: SignatureMode.SIGN_FULL_PAYLOAD,
            timestamp: Date.now(),
            identity: Buffer.from(publicKey),
            signature: Buffer.from(signature),
        }

        const header = { version: 1, opcode: 0x10, sequence: 123, payloadLength: data.length }

        const result = await SignatureVerifier.verify(auth, header, data)

        expect(result.valid).toBe(true)
        expect(result.peerIdentity).toBeDefined()
    })

    it("should reject invalid signature", async () => {
        const privateKey = ed25519.utils.randomPrivateKey()
        const publicKey = await ed25519.getPublicKey(privateKey)

        const data = Buffer.from("test message")
        const signature = Buffer.alloc(64) // Invalid signature

        const auth: AuthBlock = {
            algorithm: SignatureAlgorithm.ED25519,
            signatureMode: SignatureMode.SIGN_FULL_PAYLOAD,
            timestamp: Date.now(),
            identity: Buffer.from(publicKey),
            signature,
        }

        const header = { version: 1, opcode: 0x10, sequence: 123, payloadLength: data.length }

        const result = await SignatureVerifier.verify(auth, header, data)

        expect(result.valid).toBe(false)
        expect(result.error).toContain("Signature verification failed")
    })

    it("should reject expired timestamp", async () => {
        const privateKey = ed25519.utils.randomPrivateKey()
        const publicKey = await ed25519.getPublicKey(privateKey)

        const data = Buffer.from("test message")
        const signature = await ed25519.sign(data, privateKey)

        const auth: AuthBlock = {
            algorithm: SignatureAlgorithm.ED25519,
            signatureMode: SignatureMode.SIGN_FULL_PAYLOAD,
            timestamp: Date.now() - 10 * 60 * 1000, // 10 minutes ago
            identity: Buffer.from(publicKey),
            signature: Buffer.from(signature),
        }

        const header = { version: 1, opcode: 0x10, sequence: 123, payloadLength: data.length }

        const result = await SignatureVerifier.verify(auth, header, data)

        expect(result.valid).toBe(false)
        expect(result.error).toContain("Timestamp outside acceptable window")
    })
})
```

### 7.2 Integration Tests

```typescript
describe("Authenticated Communication", () => {
    it("should send and verify authenticated message", async () => {
        // Setup server
        const server = new OmniProtocolServer({ port: 9999 })
        await server.start()

        // Setup client with authentication
        const privateKey = ed25519.utils.randomPrivateKey()
        const publicKey = await ed25519.getPublicKey(privateKey)

        const connection = new PeerConnection("peer1", "tcp://localhost:9999")
        await connection.connect()

        // Send authenticated message
        const payload = Buffer.from("test payload")
        const response = await connection.sendAuthenticated(
            0x10, // EXECUTE opcode
            payload,
            Buffer.from(privateKey),
            Buffer.from(publicKey),
            5000
        )

        expect(response).toBeDefined()

        await connection.close()
        await server.stop()
    })
})
```

---

## 8. Implementation Checklist

- [ ] **AuthBlockParser class** (parse/encode auth blocks)
- [ ] **SignatureVerifier class** (verify signatures)
- [ ] **Ed25519 verification** (using @noble/ed25519)
- [ ] **Falcon verification** (integrate library)
- [ ] **ML-DSA verification** (integrate library)
- [ ] **Timestamp validation** (replay protection)
- [ ] **Signature mode support** (all 5 modes)
- [ ] **MessageFramer integration** (extract auth blocks)
- [ ] **Dispatcher integration** (verify before handling)
- [ ] **Client signing** (PeerConnection sendAuthenticated)
- [ ] **Key management integration** (use existing node keys)
- [ ] **Rate limiting by identity**
- [ ] **Unit tests** (parser, verifier, signature modes)
- [ ] **Integration tests** (client-server auth roundtrip)
- [ ] **Security audit** (crypto implementation review)

---

## 9. Performance Considerations

### Verification Performance

| Algorithm | Key Size | Sig Size | Verify Time |
|-----------|----------|----------|-------------|
| Ed25519 | 32 bytes | 64 bytes | ~0.5 ms |
| Falcon-512 | 897 bytes | ~666 bytes | ~2 ms |
| ML-DSA-65 | 1952 bytes | ~3309 bytes | ~1 ms |

**Target**: <5ms verification per message (easily achievable)

### Optimization

```typescript
// Cache verified identities to skip repeated verification
class IdentityCache {
    private cache: Map<string, { identity: string; lastVerified: number }> = new Map()
    private readonly cacheTimeout = 60000 // 1 minute

    get(signature: string): string | null {
        const entry = this.cache.get(signature)
        if (!entry) return null

        const age = Date.now() - entry.lastVerified
        if (age > this.cacheTimeout) {
            this.cache.delete(signature)
            return null
        }

        return entry.identity
    }

    set(signature: string, identity: string): void {
        this.cache.set(signature, {
            identity,
            lastVerified: Date.now(),
        })
    }
}
```

---

## 10. Migration Path

### Phase 1: Optional Auth (Current)

```typescript
// Auth block optional, no enforcement
if (message.auth) {
    // Verify if present, but don't require
    await verifyAuth(message.auth)
}
```

### Phase 2: Required for Write Operations

```typescript
// Require auth for state-changing operations
const WRITE_OPCODES = [0x10, 0x11, 0x12, 0x31, 0x36, 0x38]

if (WRITE_OPCODES.includes(opcode)) {
    if (!message.auth) {
        throw new Error("Authentication required")
    }
    await verifyAuth(message.auth)
}
```

### Phase 3: Required for All Operations

```typescript
// Require auth for everything
if (!message.auth) {
    throw new Error("Authentication required")
}
await verifyAuth(message.auth)
```

---

## Summary

This specification provides complete authentication implementation for OmniProtocol:

✅ **Auth Block Parsing**: Extract algorithm, timestamp, identity, signature
✅ **Signature Verification**: Support Ed25519, Falcon, ML-DSA
✅ **Replay Protection**: Timestamp validation (±5 minutes)
✅ **Identity Derivation**: Convert public key to peer identity
✅ **Middleware Integration**: Verify before dispatching to handlers
✅ **Client Signing**: Add auth blocks to outgoing messages
✅ **Performance**: <5ms verification per message
✅ **Security**: Multiple signature modes, rate limiting, nonce tracking

**Implementation Priority**: P0 - Must be completed before production use. Without authentication, the protocol is vulnerable to impersonation and replay attacks.
