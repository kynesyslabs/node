import { PrimitiveDecoder, PrimitiveEncoder } from "./primitives"

const enum NodeCallValueType {
    String = 0x01,
    Number = 0x02,
    Boolean = 0x03,
    Object = 0x04,
    Array = 0x05,
    Null = 0x06,
}

export interface PeerlistEntry {
    identity: string
    url: string
    syncStatus: boolean
    blockNumber: bigint
    blockHash: string
    metadata?: Record<string, unknown>
}

export interface PeerlistResponsePayload {
    status: number
    peers: PeerlistEntry[]
}

export interface PeerlistSyncRequestPayload {
    peerCount: number
    peerHash: Buffer
}

export interface PeerlistSyncResponsePayload {
    status: number
    peerCount: number
    peerHash: Buffer
    peers: PeerlistEntry[]
}

export interface NodeCallRequestPayload {
    method: string
    params: any[]
}

export interface NodeCallResponsePayload {
    status: number
    value: unknown
    requireReply: boolean
    extra: unknown
}

function stripHexPrefix(value: string): string {
    return value.startsWith("0x") ? value.slice(2) : value
}

function toHex(buffer: Buffer): string {
    return `0x${buffer.toString("hex")}`
}

function serializePeerEntry(peer: PeerlistEntry): Buffer {
    const identityBytes = Buffer.from(stripHexPrefix(peer.identity), "hex")
    const urlBytes = Buffer.from(peer.url, "utf8")
    const hashBytes = Buffer.from(stripHexPrefix(peer.blockHash), "hex")
    const metadata = peer.metadata ? Buffer.from(JSON.stringify(peer.metadata), "utf8") : Buffer.alloc(0)

    return Buffer.concat([
        PrimitiveEncoder.encodeBytes(identityBytes),
        PrimitiveEncoder.encodeBytes(urlBytes),
        PrimitiveEncoder.encodeBoolean(peer.syncStatus),
        PrimitiveEncoder.encodeUInt64(peer.blockNumber),
        PrimitiveEncoder.encodeBytes(hashBytes),
        PrimitiveEncoder.encodeVarBytes(metadata),
    ])
}

function deserializePeerEntry(buffer: Buffer, offset: number): { entry: PeerlistEntry; bytesRead: number } {
    let cursor = offset

    const identity = PrimitiveDecoder.decodeBytes(buffer, cursor)
    cursor += identity.bytesRead

    const url = PrimitiveDecoder.decodeBytes(buffer, cursor)
    cursor += url.bytesRead

    const syncStatus = PrimitiveDecoder.decodeBoolean(buffer, cursor)
    cursor += syncStatus.bytesRead

    const blockNumber = PrimitiveDecoder.decodeUInt64(buffer, cursor)
    cursor += blockNumber.bytesRead

    const hash = PrimitiveDecoder.decodeBytes(buffer, cursor)
    cursor += hash.bytesRead

    const metadataBytes = PrimitiveDecoder.decodeVarBytes(buffer, cursor)
    cursor += metadataBytes.bytesRead

    let metadata: Record<string, unknown> | undefined
    if (metadataBytes.value.length > 0) {
        metadata = JSON.parse(metadataBytes.value.toString("utf8")) as Record<string, unknown>
    }

    return {
        entry: {
            identity: toHex(identity.value),
            url: url.value.toString("utf8"),
            syncStatus: syncStatus.value,
            blockNumber: blockNumber.value,
            blockHash: toHex(hash.value),
            metadata,
        },
        bytesRead: cursor - offset,
    }
}

export function encodePeerlistResponse(payload: PeerlistResponsePayload): Buffer {
    const parts: Buffer[] = []

    parts.push(PrimitiveEncoder.encodeUInt16(payload.status))
    parts.push(PrimitiveEncoder.encodeUInt16(payload.peers.length))

    for (const peer of payload.peers) {
        parts.push(serializePeerEntry(peer))
    }

    return Buffer.concat(parts)
}

export function decodePeerlistResponse(buffer: Buffer): PeerlistResponsePayload {
    let offset = 0

    const { value: status, bytesRead: statusBytes } = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += statusBytes

    const { value: count, bytesRead: countBytes } = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += countBytes

    const peers: PeerlistEntry[] = []

    for (let i = 0; i < count; i++) {
        const { entry, bytesRead } = deserializePeerEntry(buffer, offset)
        peers.push(entry)
        offset += bytesRead
    }

    return { status, peers }
}

export function encodePeerlistSyncRequest(payload: PeerlistSyncRequestPayload): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.peerCount),
        PrimitiveEncoder.encodeBytes(payload.peerHash),
    ])
}

export function decodePeerlistSyncRequest(buffer: Buffer): PeerlistSyncRequestPayload {
    let offset = 0
    const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += count.bytesRead

    const hash = PrimitiveDecoder.decodeBytes(buffer, offset)
    offset += hash.bytesRead

    return {
        peerCount: count.value,
        peerHash: hash.value,
    }
}

export function encodePeerlistSyncResponse(payload: PeerlistSyncResponsePayload): Buffer {
    const parts: Buffer[] = []

    parts.push(PrimitiveEncoder.encodeUInt16(payload.status))
    parts.push(PrimitiveEncoder.encodeUInt16(payload.peerCount))
    parts.push(PrimitiveEncoder.encodeBytes(payload.peerHash))
    parts.push(PrimitiveEncoder.encodeUInt16(payload.peers.length))

    for (const peer of payload.peers) {
        parts.push(serializePeerEntry(peer))
    }

    return Buffer.concat(parts)
}

function toBigInt(value: unknown): bigint {
    if (typeof value === "bigint") return value
    if (typeof value === "number") return BigInt(Math.floor(value))
    if (typeof value === "string") {
        const trimmed = value.trim()
        if (!trimmed) return 0n
        try {
            return BigInt(trimmed)
        } catch {
            return 0n
        }
    }
    return 0n
}

function decodeNodeCallParam(buffer: Buffer, offset: number): { value: unknown; bytesRead: number } {
    let cursor = offset
    const type = PrimitiveDecoder.decodeUInt8(buffer, cursor)
    cursor += type.bytesRead

    switch (type.value) {
        case NodeCallValueType.String: {
            const result = PrimitiveDecoder.decodeString(buffer, cursor)
            cursor += result.bytesRead
            return { value: result.value, bytesRead: cursor - offset }
        }
        case NodeCallValueType.Number: {
            const result = PrimitiveDecoder.decodeUInt64(buffer, cursor)
            cursor += result.bytesRead
            const numeric = Number(result.value)
            return { value: numeric, bytesRead: cursor - offset }
        }
        case NodeCallValueType.Boolean: {
            const result = PrimitiveDecoder.decodeBoolean(buffer, cursor)
            cursor += result.bytesRead
            return { value: result.value, bytesRead: cursor - offset }
        }
        case NodeCallValueType.Object: {
            const json = PrimitiveDecoder.decodeVarBytes(buffer, cursor)
            cursor += json.bytesRead
            try {
                return {
                    value: JSON.parse(json.value.toString("utf8")),
                    bytesRead: cursor - offset,
                }
            } catch {
                return { value: {}, bytesRead: cursor - offset }
            }
        }
        case NodeCallValueType.Array: {
            const count = PrimitiveDecoder.decodeUInt16(buffer, cursor)
            cursor += count.bytesRead
            const values: unknown[] = []
            for (let i = 0; i < count.value; i++) {
                const decoded = decodeNodeCallParam(buffer, cursor)
                cursor += decoded.bytesRead
                values.push(decoded.value)
            }
            return { value: values, bytesRead: cursor - offset }
        }
        case NodeCallValueType.Null:
        default:
            return { value: null, bytesRead: cursor - offset }
    }
}

function encodeNodeCallValue(value: unknown): { type: NodeCallValueType; buffer: Buffer } {
    if (value === null || value === undefined) {
        return { type: NodeCallValueType.Null, buffer: Buffer.alloc(0) }
    }

    if (typeof value === "string") {
        return { type: NodeCallValueType.String, buffer: PrimitiveEncoder.encodeString(value) }
    }

    if (typeof value === "number") {
        return {
            type: NodeCallValueType.Number,
            buffer: PrimitiveEncoder.encodeUInt64(toBigInt(value)),
        }
    }

    if (typeof value === "boolean") {
        return {
            type: NodeCallValueType.Boolean,
            buffer: PrimitiveEncoder.encodeBoolean(value),
        }
    }

    if (typeof value === "bigint") {
        return {
            type: NodeCallValueType.Number,
            buffer: PrimitiveEncoder.encodeUInt64(value),
        }
    }

    if (Array.isArray(value)) {
        const parts: Buffer[] = []
        parts.push(PrimitiveEncoder.encodeUInt16(value.length))
        for (const item of value) {
            const encoded = encodeNodeCallValue(item)
            parts.push(PrimitiveEncoder.encodeUInt8(encoded.type))
            parts.push(encoded.buffer)
        }
        return { type: NodeCallValueType.Array, buffer: Buffer.concat(parts) }
    }

    return {
        type: NodeCallValueType.Object,
        buffer: PrimitiveEncoder.encodeVarBytes(
            Buffer.from(JSON.stringify(value), "utf8"),
        ),
    }
}

export function decodeNodeCallRequest(buffer: Buffer): NodeCallRequestPayload {
    let offset = 0
    const method = PrimitiveDecoder.decodeString(buffer, offset)
    offset += method.bytesRead

    const paramCount = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += paramCount.bytesRead

    const params: unknown[] = []
    for (let i = 0; i < paramCount.value; i++) {
        const decoded = decodeNodeCallParam(buffer, offset)
        offset += decoded.bytesRead
        params.push(decoded.value)
    }

    return {
        method: method.value,
        params,
    }
}

export function encodeNodeCallRequest(payload: NodeCallRequestPayload): Buffer {
    const parts: Buffer[] = [PrimitiveEncoder.encodeString(payload.method)]
    parts.push(PrimitiveEncoder.encodeUInt16(payload.params.length))

    for (const param of payload.params) {
        const encoded = encodeNodeCallValue(param)
        parts.push(PrimitiveEncoder.encodeUInt8(encoded.type))
        parts.push(encoded.buffer)
    }

    return Buffer.concat(parts)
}

export function encodeNodeCallResponse(payload: NodeCallResponsePayload): Buffer {
    const encoded = encodeNodeCallValue(payload.value)
    const parts: Buffer[] = [
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeUInt8(encoded.type),
        encoded.buffer,
        PrimitiveEncoder.encodeBoolean(payload.requireReply ?? false),
        PrimitiveEncoder.encodeVarBytes(
            Buffer.from(JSON.stringify(payload.extra ?? null), "utf8"),
        ),
    ]

    return Buffer.concat(parts)
}

export function decodeNodeCallResponse(buffer: Buffer): NodeCallResponsePayload {
    let offset = 0

    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const type = PrimitiveDecoder.decodeUInt8(buffer, offset)
    offset += type.bytesRead

    let value: unknown = null

    switch (type.value as NodeCallValueType) {
        case NodeCallValueType.String: {
            const decoded = PrimitiveDecoder.decodeString(buffer, offset)
            offset += decoded.bytesRead
            value = decoded.value
            break
        }
        case NodeCallValueType.Number: {
            const decoded = PrimitiveDecoder.decodeUInt64(buffer, offset)
            offset += decoded.bytesRead
            value = Number(decoded.value)
            break
        }
        case NodeCallValueType.Boolean: {
            const decoded = PrimitiveDecoder.decodeBoolean(buffer, offset)
            offset += decoded.bytesRead
            value = decoded.value
            break
        }
        case NodeCallValueType.Object: {
            const decoded = PrimitiveDecoder.decodeVarBytes(buffer, offset)
            offset += decoded.bytesRead
            try {
                value = JSON.parse(decoded.value.toString("utf8"))
            } catch {
                value = {}
            }
            break
        }
        case NodeCallValueType.Array: {
            const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
            offset += count.bytesRead
            const values: unknown[] = []
            for (let i = 0; i < count.value; i++) {
                const element = decodeNodeCallParam(buffer, offset)
                offset += element.bytesRead
                values.push(element.value)
            }
            value = values
            break
        }
        case NodeCallValueType.Null:
        default:
            value = null
            break
    }

    const requireReply = PrimitiveDecoder.decodeBoolean(buffer, offset)
    offset += requireReply.bytesRead

    const extra = PrimitiveDecoder.decodeVarBytes(buffer, offset)
    offset += extra.bytesRead

    let extraValue: unknown = null
    try {
        extraValue = JSON.parse(extra.value.toString("utf8"))
    } catch {
        extraValue = null
    }

    return {
        status: status.value,
        value,
        requireReply: requireReply.value,
        extra: extraValue,
    }
}

export function encodeStringResponse(status: number, value: string): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(status),
        PrimitiveEncoder.encodeString(value ?? ""),
    ])
}

export function decodeStringResponse(buffer: Buffer): { status: number; value: string } {
    const status = PrimitiveDecoder.decodeUInt16(buffer, 0)
    const value = PrimitiveDecoder.decodeString(buffer, status.bytesRead)
    return { status: status.value, value: value.value }
}

export function encodeJsonResponse(status: number, value: unknown): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(status),
        PrimitiveEncoder.encodeVarBytes(
            Buffer.from(JSON.stringify(value ?? null), "utf8"),
        ),
    ])
}

export function decodeJsonResponse(buffer: Buffer): { status: number; value: unknown } {
    const status = PrimitiveDecoder.decodeUInt16(buffer, 0)
    const body = PrimitiveDecoder.decodeVarBytes(buffer, status.bytesRead)
    let parsed: unknown = null
    try {
        parsed = JSON.parse(body.value.toString("utf8"))
    } catch {
        parsed = null
    }
    return { status: status.value, value: parsed }
}

export function decodePeerlistSyncResponse(buffer: Buffer): PeerlistSyncResponsePayload {
    let offset = 0

    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const theirCount = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += theirCount.bytesRead

    const hash = PrimitiveDecoder.decodeBytes(buffer, offset)
    offset += hash.bytesRead

    const peerCount = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += peerCount.bytesRead

    const peers: PeerlistEntry[] = []
    for (let i = 0; i < peerCount.value; i++) {
        const { entry, bytesRead } = deserializePeerEntry(buffer, offset)
        peers.push(entry)
        offset += bytesRead
    }

    return {
        status: status.value,
        peerCount: theirCount.value,
        peerHash: hash.value,
        peers,
    }
}
