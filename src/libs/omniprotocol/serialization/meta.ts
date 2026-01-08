import { PrimitiveDecoder, PrimitiveEncoder } from "./primitives"

export interface VersionNegotiateRequest {
    minVersion: number
    maxVersion: number
    supportedVersions: number[]
}

export interface VersionNegotiateResponse {
    status: number
    negotiatedVersion: number
}

export function decodeVersionNegotiateRequest(buffer: Buffer): VersionNegotiateRequest {
    let offset = 0
    const min = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += min.bytesRead

    const max = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += max.bytesRead

    const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += count.bytesRead

    const versions: number[] = []
    for (let i = 0; i < count.value; i++) {
        const ver = PrimitiveDecoder.decodeUInt16(buffer, offset)
        offset += ver.bytesRead
        versions.push(ver.value)
    }

    return {
        minVersion: min.value,
        maxVersion: max.value,
        supportedVersions: versions,
    }
}

export function encodeVersionNegotiateResponse(payload: VersionNegotiateResponse): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeUInt16(payload.negotiatedVersion),
    ])
}

export interface CapabilityDescriptor {
    featureId: number
    version: number
    enabled: boolean
}

export interface CapabilityExchangeRequest {
    features: CapabilityDescriptor[]
}

export interface CapabilityExchangeResponse {
    status: number
    features: CapabilityDescriptor[]
}

export function decodeCapabilityExchangeRequest(buffer: Buffer): CapabilityExchangeRequest {
    let offset = 0
    const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += count.bytesRead

    const features: CapabilityDescriptor[] = []
    for (let i = 0; i < count.value; i++) {
        const id = PrimitiveDecoder.decodeUInt16(buffer, offset)
        offset += id.bytesRead

        const version = PrimitiveDecoder.decodeUInt16(buffer, offset)
        offset += version.bytesRead

        const enabled = PrimitiveDecoder.decodeBoolean(buffer, offset)
        offset += enabled.bytesRead

        features.push({
            featureId: id.value,
            version: version.value,
            enabled: enabled.value,
        })
    }

    return { features }
}

export function encodeCapabilityExchangeResponse(payload: CapabilityExchangeResponse): Buffer {
    const parts: Buffer[] = []
    parts.push(PrimitiveEncoder.encodeUInt16(payload.status))
    parts.push(PrimitiveEncoder.encodeUInt16(payload.features.length))

    for (const feature of payload.features) {
        parts.push(PrimitiveEncoder.encodeUInt16(feature.featureId))
        parts.push(PrimitiveEncoder.encodeUInt16(feature.version))
        parts.push(PrimitiveEncoder.encodeBoolean(feature.enabled))
    }

    return Buffer.concat(parts)
}

export interface ProtocolErrorPayload {
    errorCode: number
    message: string
}

export function decodeProtocolError(buffer: Buffer): ProtocolErrorPayload {
    let offset = 0
    const code = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += code.bytesRead

    const message = PrimitiveDecoder.decodeString(buffer, offset)
    offset += message.bytesRead

    return {
        errorCode: code.value,
        message: message.value,
    }
}

export function encodeProtocolError(payload: ProtocolErrorPayload): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.errorCode),
        PrimitiveEncoder.encodeString(payload.message ?? ""),
    ])
}

export interface ProtocolPingPayload {
    timestamp: bigint
}

export function decodeProtocolPing(buffer: Buffer): ProtocolPingPayload {
    const timestamp = PrimitiveDecoder.decodeUInt64(buffer, 0)
    return { timestamp: timestamp.value }
}

export interface ProtocolPingResponse {
    status: number
    timestamp: bigint
}

export function encodeProtocolPingResponse(payload: ProtocolPingResponse): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeUInt64(payload.timestamp),
    ])
}

export interface ProtocolDisconnectPayload {
    reason: number
    message: string
}

export function decodeProtocolDisconnect(buffer: Buffer): ProtocolDisconnectPayload {
    let offset = 0
    const reason = PrimitiveDecoder.decodeUInt8(buffer, offset)
    offset += reason.bytesRead

    const message = PrimitiveDecoder.decodeString(buffer, offset)
    offset += message.bytesRead

    return {
        reason: reason.value,
        message: message.value,
    }
}

export function encodeProtocolDisconnect(payload: ProtocolDisconnectPayload): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt8(payload.reason),
        PrimitiveEncoder.encodeString(payload.message ?? ""),
    ])
}
