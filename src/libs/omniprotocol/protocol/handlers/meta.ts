import { OmniHandler } from "../../types/message"
import {
    decodeCapabilityExchangeRequest,
    decodeProtocolDisconnect,
    decodeProtocolError,
    decodeProtocolPing,
    decodeVersionNegotiateRequest,
    encodeCapabilityExchangeResponse,
    encodeProtocolPingResponse,
    encodeVersionNegotiateResponse,
    CapabilityDescriptor,
} from "../../serialization/meta"
import log from "src/utilities/logger"

const CURRENT_PROTOCOL_VERSION = 0x0001

const SUPPORTED_CAPABILITIES: CapabilityDescriptor[] = [
    { featureId: 0x0001, version: 0x0001, enabled: true }, // Compression
    { featureId: 0x0002, version: 0x0001, enabled: false }, // Encryption placeholder
    { featureId: 0x0003, version: 0x0001, enabled: true }, // Batching
]

export const handleProtoVersionNegotiate: OmniHandler = async ({ message }) => {
    let requestVersions = [CURRENT_PROTOCOL_VERSION]
    let minVersion = CURRENT_PROTOCOL_VERSION
    let maxVersion = CURRENT_PROTOCOL_VERSION

    if (message.payload && message.payload.length > 0) {
        try {
            const decoded = decodeVersionNegotiateRequest(message.payload)
            requestVersions = decoded.supportedVersions.length
                ? decoded.supportedVersions
                : requestVersions
            minVersion = decoded.minVersion
            maxVersion = decoded.maxVersion
        } catch (error) {
            log.error("[ProtoVersionNegotiate] Failed to decode request", error)
            return encodeVersionNegotiateResponse({ status: 400, negotiatedVersion: 0 })
        }
    }

    const candidates = requestVersions.filter(
        version => version >= minVersion && version <= maxVersion && version === CURRENT_PROTOCOL_VERSION,
    )

    if (candidates.length === 0) {
        return encodeVersionNegotiateResponse({ status: 406, negotiatedVersion: 0 })
    }

    return encodeVersionNegotiateResponse({
        status: 200,
        negotiatedVersion: candidates[candidates.length - 1],
    })
}

export const handleProtoCapabilityExchange: OmniHandler = async ({ message }) => {
    if (message.payload && message.payload.length > 0) {
        try {
            decodeCapabilityExchangeRequest(message.payload)
        } catch (error) {
            log.error("[ProtoCapabilityExchange] Failed to decode request", error)
            return encodeCapabilityExchangeResponse({ status: 400, features: [] })
        }
    }

    return encodeCapabilityExchangeResponse({
        status: 200,
        features: SUPPORTED_CAPABILITIES,
    })
}

export const handleProtoError: OmniHandler = async ({ message, context }) => {
    if (message.payload && message.payload.length > 0) {
        try {
            const decoded = decodeProtocolError(message.payload)
            log.error(
                `[ProtoError] Peer ${context.peerIdentity} reported error ${decoded.errorCode}: ${decoded.message}`,
            )
        } catch (error) {
            log.error("[ProtoError] Failed to decode payload", error)
        }
    }

    return Buffer.alloc(0)
}

export const handleProtoPing: OmniHandler = async ({ message }) => {
    let timestamp = BigInt(Date.now())

    if (message.payload && message.payload.length > 0) {
        try {
            const decoded = decodeProtocolPing(message.payload)
            timestamp = decoded.timestamp
        } catch (error) {
            log.error("[ProtoPing] Failed to decode payload", error)
            return encodeProtocolPingResponse({ status: 400, timestamp })
        }
    }

    return encodeProtocolPingResponse({ status: 200, timestamp })
}

export const handleProtoDisconnect: OmniHandler = async ({ message, context }) => {
    if (message.payload && message.payload.length > 0) {
        try {
            const decoded = decodeProtocolDisconnect(message.payload)
            log.info(
                `[ProtoDisconnect] Peer ${context.peerIdentity} disconnected: reason=${decoded.reason} message=${decoded.message}`,
            )
        } catch (error) {
            log.error("[ProtoDisconnect] Failed to decode payload", error)
        }
    }

    return Buffer.alloc(0)
}
