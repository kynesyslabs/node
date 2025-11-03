// REVIEW: MessageFramer - Parse TCP stream into complete OmniProtocol messages
import { Buffer } from "buffer"
import { crc32 } from "crc"
import type { OmniMessage, OmniMessageHeader } from "../types/message"
import { PrimitiveDecoder, PrimitiveEncoder } from "../serialization/primitives"

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

    /**
     * Add data received from TCP socket
     * @param chunk Raw data from socket
     */
    addData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk])
    }

    /**
     * Try to extract a complete message from buffered data
     * @returns Complete message or null if insufficient data
     */
    extractMessage(): OmniMessage | null {
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

        const payload = messageBuffer.subarray(
            payloadOffset,
            checksumOffset,
        )
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
     * @returns Complete message buffer ready to send
     * @static
     */
    static encodeMessage(
        header: OmniMessageHeader,
        payload: Buffer,
    ): Buffer {
        // Encode header (12 bytes)
        const versionBuf = PrimitiveEncoder.encodeUInt16(header.version)
        const opcodeBuf = PrimitiveEncoder.encodeUInt8(header.opcode)
        const flagsBuf = PrimitiveEncoder.encodeUInt8(0) // Flags = 0 for now
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

        // Calculate checksum over header + payload
        const dataToCheck = Buffer.concat([headerBuf, payload])
        const checksum = crc32(dataToCheck)
        const checksumBuf = PrimitiveEncoder.encodeUInt32(checksum)

        // Return complete message
        return Buffer.concat([headerBuf, payload, checksumBuf])
    }
}
