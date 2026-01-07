// REVIEW: MessageFramer - Parse TCP stream into complete OmniProtocol messages
import log from "src/utilities/logger"
import { Buffer } from "buffer"
import { crc32 } from "crc"
import type {
    OmniMessage,
    OmniMessageHeader,
    ParsedOmniMessage,
} from "../types/message"
import { PrimitiveDecoder, PrimitiveEncoder } from "../serialization/primitives"
import { AuthBlockParser } from "../auth/parser"
import type { AuthBlock } from "../auth/types"
import { InvalidAuthBlockFormatError } from "../types/errors"

/**
 * MessageFramer handles parsing of TCP byte streams into complete OmniProtocol messages
 *
 * Message format:
 * ┌──────────────┬────────────┬──────────────┐
 * │   Header     │  Payload   │   Checksum   │
 * │  12 bytes    │  variable  │   4 bytes    │
 * └──────────────┴────────────┴──────────────┘
 *
 * Header format (12 bytes):
 * - version: 2 bytes (uint16, big-endian)
 * - opcode: 1 byte (uint8)
 * - flags: 1 byte (uint8)
 * - payloadLength: 4 bytes (uint32, big-endian)
 * - sequence: 4 bytes (uint32, big-endian) - message ID
 */
export class MessageFramer {
    private buffer: Buffer = Buffer.alloc(0)

    /** Minimum header size in bytes */
    private static readonly HEADER_SIZE = 12
    /** Checksum size in bytes (CRC32) */
    private static readonly CHECKSUM_SIZE = 4
    /** Minimum complete message size */
    private static readonly MIN_MESSAGE_SIZE =
        MessageFramer.HEADER_SIZE + MessageFramer.CHECKSUM_SIZE
    /** Maximum payload size (16MB) to prevent DoS attacks */
    private static readonly MAX_PAYLOAD_SIZE = 16 * 1024 * 1024

    /**
     * Add data received from TCP socket
     * @param chunk Raw data from socket
     */
    addData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk])
    }

    /**
     * Try to extract a complete message from buffered data
     * @returns Complete message with auth block or null if insufficient data
     */
    extractMessage(): ParsedOmniMessage | null {
        // Need at least header + checksum to proceed
        if (this.buffer.length < MessageFramer.MIN_MESSAGE_SIZE) {
            return null
        }

        // Parse header to get payload length
        const header = this.parseHeader()
        if (!header) {
            return null // Invalid header
        }

        let offset = MessageFramer.HEADER_SIZE

        // Check if auth block is present (Flags bit 0)
        let auth: AuthBlock | null = null
        if (this.isAuthRequired(header)) {
            // Need to peek at auth block to know its size
            if (this.buffer.length < offset + 12) {
                return null // Need at least auth header
            }

            try {
                const authResult = AuthBlockParser.parse(this.buffer, offset)
                auth = authResult.auth
                offset += authResult.bytesRead
            } catch (error) {
                console.error(error)
                log.error("================================================")
                log.error("BUFFER: " + JSON.stringify(this.buffer, null, 2))
                log.error("OFFSET: " + offset)
                log.error("HEADER: " + JSON.stringify(header, null, 2))
                log.error("Failed to parse auth block: " + error)
                throw new InvalidAuthBlockFormatError(
                    "Failed to parse auth block",
                )
            }
        }

        // Calculate total message size including auth block
        const totalSize =
            offset + header.payloadLength + MessageFramer.CHECKSUM_SIZE

        // Check if we have the complete message
        if (this.buffer.length < totalSize) {
            return null // Need more data
        }

        // Extract complete message
        const messageBuffer = this.buffer.subarray(0, totalSize)
        this.buffer = this.buffer.subarray(totalSize)

        // Parse payload and checksum
        const payload = messageBuffer.subarray(
            offset,
            offset + header.payloadLength,
        )
        const checksumOffset = offset + header.payloadLength
        const checksum = messageBuffer.readUInt32BE(checksumOffset)

        // Validate checksum (over everything except checksum itself)
        if (!this.validateChecksum(messageBuffer, checksum)) {
            throw new Error(
                "Message checksum validation failed - corrupted data",
            )
        }

        return {
            header,
            auth,
            payload,
        }
    }

    /**
     * Extract legacy message without auth block parsing (for backwards compatibility)
     */
    extractLegacyMessage(): OmniMessage | null {
        // Need at least header + checksum to proceed
        if (this.buffer.length < MessageFramer.MIN_MESSAGE_SIZE) {
            return null
        }

        // Parse header to get payload length
        const header = this.parseHeader()
        if (!header) {
            return null // Invalid header
        }

        // Calculate total message size
        const totalSize =
            MessageFramer.HEADER_SIZE +
            header.payloadLength +
            MessageFramer.CHECKSUM_SIZE

        // Check if we have the complete message
        if (this.buffer.length < totalSize) {
            return null // Need more data
        }

        // Extract complete message
        const messageBuffer = this.buffer.subarray(0, totalSize)
        this.buffer = this.buffer.subarray(totalSize)

        // Parse payload and checksum
        const payloadOffset = MessageFramer.HEADER_SIZE
        const checksumOffset = payloadOffset + header.payloadLength

        const payload = messageBuffer.subarray(payloadOffset, checksumOffset)
        const checksum = messageBuffer.readUInt32BE(checksumOffset)

        // Validate checksum
        if (!this.validateChecksum(messageBuffer, checksum)) {
            throw new Error(
                "Message checksum validation failed - corrupted data",
            )
        }

        return {
            header,
            payload,
            checksum,
        }
    }

    /**
     * Parse header from current buffer
     * @returns Parsed header or null if insufficient data
     * @private
     */
    private parseHeader(): OmniMessageHeader | null {
        if (this.buffer.length < MessageFramer.HEADER_SIZE) {
            return null
        }

        let offset = 0

        // Version (2 bytes)
        const { value: version, bytesRead: versionBytes } =
            PrimitiveDecoder.decodeUInt16(this.buffer, offset)
        offset += versionBytes

        // Opcode (1 byte)
        const { value: opcode, bytesRead: opcodeBytes } =
            PrimitiveDecoder.decodeUInt8(this.buffer, offset)
        offset += opcodeBytes

        // Flags (1 byte) - skip for now, not in current header structure
        const { bytesRead: flagsBytes } = PrimitiveDecoder.decodeUInt8(
            this.buffer,
            offset,
        )
        offset += flagsBytes

        // Payload length (4 bytes)
        const { value: payloadLength, bytesRead: lengthBytes } =
            PrimitiveDecoder.decodeUInt32(this.buffer, offset)
        offset += lengthBytes

        // Validate payload size to prevent DoS attacks
        if (payloadLength > MessageFramer.MAX_PAYLOAD_SIZE) {
            // Drop buffered data so we don't retain attacker-controlled bytes in memory
            this.buffer = Buffer.alloc(0)
            throw new Error(
                `Payload size ${payloadLength} exceeds maximum ${MessageFramer.MAX_PAYLOAD_SIZE}`,
            )
        }

        // Sequence/Message ID (4 bytes)
        const { value: sequence, bytesRead: sequenceBytes } =
            PrimitiveDecoder.decodeUInt32(this.buffer, offset)
        offset += sequenceBytes

        return {
            version,
            opcode,
            sequence,
            payloadLength,
        }
    }

    /**
     * Validate message checksum (CRC32)
     * @param messageBuffer Complete message buffer (header + payload + checksum)
     * @param receivedChecksum Checksum from message
     * @returns true if checksum is valid
     * @private
     */
    private validateChecksum(
        messageBuffer: Buffer,
        receivedChecksum: number,
    ): boolean {
        // Calculate checksum over header + payload (excluding checksum itself)
        const dataToCheck = messageBuffer.subarray(
            0,
            messageBuffer.length - MessageFramer.CHECKSUM_SIZE,
        )
        const calculatedChecksum = crc32(dataToCheck)

        return calculatedChecksum === receivedChecksum
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
     * Get current buffer size (for debugging/metrics)
     * @returns Number of bytes in buffer
     */
    getBufferSize(): number {
        return this.buffer.length
    }

    /**
     * Clear internal buffer (e.g., after connection reset)
     */
    clear(): void {
        this.buffer = Buffer.alloc(0)
    }

    /**
     * Encode a complete OmniMessage into binary format for sending
     * @param header Message header
     * @param payload Message payload
     * @param auth Optional authentication block
     * @param flags Optional flags byte (default: 0)
     * @returns Complete message buffer ready to send
     * @static
     */
    static encodeMessage(
        header: OmniMessageHeader,
        payload: Buffer,
        auth?: AuthBlock | null,
        flags?: number,
    ): Buffer {
        // Validate payload size before encoding
        if (payload.length > MessageFramer.MAX_PAYLOAD_SIZE) {
            throw new Error(`Payload size ${payload.length} exceeds maximum ${MessageFramer.MAX_PAYLOAD_SIZE}`)
        }

        // Determine flags
        const flagsByte = flags !== undefined ? flags : auth ? 0x01 : 0x00

        // Encode header (12 bytes)
        const versionBuf = PrimitiveEncoder.encodeUInt16(header.version)
        const opcodeBuf = PrimitiveEncoder.encodeUInt8(header.opcode)
        const flagsBuf = PrimitiveEncoder.encodeUInt8(flagsByte)
        const lengthBuf = PrimitiveEncoder.encodeUInt32(payload.length)
        const sequenceBuf = PrimitiveEncoder.encodeUInt32(header.sequence)

        // Combine header parts
        const headerBuf = Buffer.concat([
            versionBuf,
            opcodeBuf,
            flagsBuf,
            lengthBuf,
            sequenceBuf,
        ])

        // Encode auth block if present
        const authBuf = auth ? AuthBlockParser.encode(auth) : Buffer.alloc(0)

        // Calculate checksum over header + auth + payload
        const dataToCheck = Buffer.concat([headerBuf, authBuf, payload])
        const checksum = crc32(dataToCheck)
        const checksumBuf = PrimitiveEncoder.encodeUInt32(checksum)

        // Return complete message
        return Buffer.concat([headerBuf, authBuf, payload, checksumBuf])
    }
}
