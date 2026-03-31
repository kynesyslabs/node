export class PrimitiveEncoder {
    static encodeUInt8(value: number): Buffer {
        const buffer = Buffer.allocUnsafe(1)
        buffer.writeUInt8(value, 0)
        return buffer
    }

    static encodeBoolean(value: boolean): Buffer {
        return this.encodeUInt8(value ? 1 : 0)
    }

    static encodeUInt16(value: number): Buffer {
        const buffer = Buffer.allocUnsafe(2)
        buffer.writeUInt16BE(value, 0)
        return buffer
    }

    static encodeUInt32(value: number): Buffer {
        const buffer = Buffer.allocUnsafe(4)
        buffer.writeUInt32BE(value, 0)
        return buffer
    }

    static encodeUInt64(value: bigint | number): Buffer {
        const big = typeof value === "number" ? BigInt(value) : value
        const buffer = Buffer.allocUnsafe(8)
        buffer.writeBigUInt64BE(big, 0)
        return buffer
    }

    static encodeString(value: string): Buffer {
        const data = Buffer.from(value, "utf8")
        const length = this.encodeUInt16(data.length)
        return Buffer.concat([length, data])
    }

    static encodeBytes(data: Buffer): Buffer {
        const length = this.encodeUInt16(data.length)
        return Buffer.concat([length, data])
    }

    static encodeVarBytes(data: Buffer): Buffer {
        const length = this.encodeUInt32(data.length)
        return Buffer.concat([length, data])
    }
}

export class PrimitiveDecoder {
    static decodeUInt8(
        buffer: Buffer,
        offset = 0,
    ): { value: number; bytesRead: number } {
        return { value: buffer.readUInt8(offset), bytesRead: 1 }
    }

    static decodeBoolean(
        buffer: Buffer,
        offset = 0,
    ): { value: boolean; bytesRead: number } {
        const { value, bytesRead } = this.decodeUInt8(buffer, offset)
        return { value: value !== 0, bytesRead }
    }

    static decodeUInt16(
        buffer: Buffer,
        offset = 0,
    ): { value: number; bytesRead: number } {
        return { value: buffer.readUInt16BE(offset), bytesRead: 2 }
    }

    static decodeUInt32(
        buffer: Buffer,
        offset = 0,
    ): { value: number; bytesRead: number } {
        return { value: buffer.readUInt32BE(offset), bytesRead: 4 }
    }

    static decodeUInt64(
        buffer: Buffer,
        offset = 0,
    ): { value: bigint; bytesRead: number } {
        return { value: buffer.readBigUInt64BE(offset), bytesRead: 8 }
    }

    static decodeString(
        buffer: Buffer,
        offset = 0,
    ): { value: string; bytesRead: number } {
        const { value: length, bytesRead: lenBytes } = this.decodeUInt16(
            buffer,
            offset,
        )
        const start = offset + lenBytes
        const end = start + length
        return {
            value: buffer.subarray(start, end).toString("utf8"),
            bytesRead: lenBytes + length,
        }
    }

    static decodeBytes(
        buffer: Buffer,
        offset = 0,
    ): { value: Buffer; bytesRead: number } {
        const { value: length, bytesRead: lenBytes } = this.decodeUInt16(
            buffer,
            offset,
        )
        const start = offset + lenBytes
        const end = start + length
        return {
            value: buffer.subarray(start, end),
            bytesRead: lenBytes + length,
        }
    }

    static decodeVarBytes(
        buffer: Buffer,
        offset = 0,
    ): { value: Buffer; bytesRead: number } {
        const { value: length, bytesRead: lenBytes } = this.decodeUInt32(
            buffer,
            offset,
        )
        const start = offset + lenBytes
        const end = start + length
        return {
            value: buffer.subarray(start, end),
            bytesRead: lenBytes + length,
        }
    }
}
