import { PrimitiveDecoder, PrimitiveEncoder } from "../serialization/primitives"
import { AuthBlock, SignatureAlgorithm, SignatureMode } from "./types"

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
        parts.push(PrimitiveEncoder.encodeUInt8(auth.algorithm))

        // Signature Mode (1 byte)
        parts.push(PrimitiveEncoder.encodeUInt8(auth.signatureMode))

        // Timestamp (8 bytes)
        parts.push(PrimitiveEncoder.encodeUInt64(auth.timestamp))

        // Identity Length (2 bytes)
        parts.push(PrimitiveEncoder.encodeUInt16(auth.identity.length))

        // Identity (variable)
        parts.push(auth.identity)

        // Signature Length (2 bytes)
        parts.push(PrimitiveEncoder.encodeUInt16(auth.signature.length))

        // Signature (variable)
        parts.push(auth.signature)

        return Buffer.concat(parts)
    }

    /**
     * Calculate size of auth block in bytes
     */
    static calculateSize(auth: AuthBlock): number {
        return (
            1 + // algorithm
            1 + // signature mode
            8 + // timestamp
            2 + // identity length
            auth.identity.length +
            2 + // signature length
            auth.signature.length
        )
    }
}
