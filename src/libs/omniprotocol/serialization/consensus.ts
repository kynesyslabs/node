import { PrimitiveDecoder, PrimitiveEncoder } from "./primitives"

function stripHexPrefix(value: string): string {
    return value.startsWith("0x") ? value.slice(2) : value
}

function ensureHexPrefix(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
        return "0x"
    }
    return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`
}

function encodeHexBytes(hex: string): Buffer {
    const normalized = stripHexPrefix(hex)
    return PrimitiveEncoder.encodeBytes(Buffer.from(normalized, "hex"))
}

function decodeHexBytes(
    buffer: Buffer,
    offset: number,
): {
    value: string
    bytesRead: number
} {
    const decoded = PrimitiveDecoder.decodeBytes(buffer, offset)
    return {
        value: ensureHexPrefix(decoded.value.toString("hex")),
        bytesRead: decoded.bytesRead,
    }
}

function encodeStringMap(map: Record<string, string>): Buffer {
    const entries = Object.entries(map ?? {})
    const parts: Buffer[] = [PrimitiveEncoder.encodeUInt16(entries.length)]

    for (const [key, value] of entries) {
        parts.push(encodeHexBytes(key))
        parts.push(encodeHexBytes(value))
    }

    return Buffer.concat(parts)
}

function decodeStringMap(
    buffer: Buffer,
    offset: number,
): { value: Record<string, string>; bytesRead: number } {
    const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
    let cursor = offset + count.bytesRead
    const map: Record<string, string> = {}

    for (let i = 0; i < count.value; i++) {
        const key = decodeHexBytes(buffer, cursor)
        cursor += key.bytesRead
        const value = decodeHexBytes(buffer, cursor)
        cursor += value.bytesRead
        map[key.value] = value.value
    }

    return { value: map, bytesRead: cursor - offset }
}

export interface ProposeBlockHashRequestPayload {
    blockHash: string
    validationData: Record<string, string>
    proposer: string
}

// REVIEW: Client-side encoder for proposeBlockHash requests
export function encodeProposeBlockHashRequest(
    payload: ProposeBlockHashRequestPayload,
): Buffer {
    return Buffer.concat([
        encodeHexBytes(payload.blockHash ?? ""),
        encodeStringMap(payload.validationData ?? {}),
        encodeHexBytes(payload.proposer ?? ""),
    ])
}

export function decodeProposeBlockHashRequest(
    buffer: Buffer,
): ProposeBlockHashRequestPayload {
    let offset = 0

    const blockHash = decodeHexBytes(buffer, offset)
    offset += blockHash.bytesRead

    const validationData = decodeStringMap(buffer, offset)
    offset += validationData.bytesRead

    const proposer = decodeHexBytes(buffer, offset)
    offset += proposer.bytesRead

    return {
        blockHash: blockHash.value,
        validationData: validationData.value,
        proposer: proposer.value,
    }
}

export interface ProposeBlockHashResponsePayload {
    status: number
    voter: string
    voteAccepted: boolean
    signatures: Record<string, string>
    metadata?: unknown
}

export function encodeProposeBlockHashResponse(
    payload: ProposeBlockHashResponsePayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        encodeHexBytes(payload.voter),
        PrimitiveEncoder.encodeBoolean(payload.voteAccepted),
        encodeStringMap(payload.signatures ?? {}),
        PrimitiveEncoder.encodeVarBytes(
            Buffer.from(JSON.stringify(payload.metadata ?? null), "utf8"),
        ),
    ])
}

export function decodeProposeBlockHashResponse(
    buffer: Buffer,
): ProposeBlockHashResponsePayload {
    let offset = 0

    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const voter = decodeHexBytes(buffer, offset)
    offset += voter.bytesRead

    const vote = PrimitiveDecoder.decodeBoolean(buffer, offset)
    offset += vote.bytesRead

    const signatures = decodeStringMap(buffer, offset)
    offset += signatures.bytesRead

    const metadataBytes = PrimitiveDecoder.decodeVarBytes(buffer, offset)
    offset += metadataBytes.bytesRead

    let metadata: unknown = null
    try {
        metadata = JSON.parse(metadataBytes.value.toString("utf8"))
    } catch {
        metadata = null
    }

    return {
        status: status.value,
        voter: voter.value,
        voteAccepted: vote.value,
        signatures: signatures.value,
        metadata,
    }
}

export interface ValidatorSeedResponsePayload {
    status: number
    seed: string
}

export function encodeValidatorSeedResponse(
    payload: ValidatorSeedResponsePayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        encodeHexBytes(payload.seed ?? ""),
    ])
}

export interface ValidatorTimestampResponsePayload {
    status: number
    timestamp: bigint
    metadata?: unknown
}

export function encodeValidatorTimestampResponse(
    payload: ValidatorTimestampResponsePayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeUInt64(payload.timestamp ?? BigInt(0)),
        PrimitiveEncoder.encodeVarBytes(
            Buffer.from(JSON.stringify(payload.metadata ?? null), "utf8"),
        ),
    ])
}

export interface SetValidatorPhaseRequestPayload {
    phase: number
    seed: string
    blockRef: bigint
}

// REVIEW: Client-side encoder for setValidatorPhase requests
export function encodeSetValidatorPhaseRequest(
    payload: SetValidatorPhaseRequestPayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt8(payload.phase),
        encodeHexBytes(payload.seed ?? ""),
        PrimitiveEncoder.encodeUInt64(payload.blockRef ?? BigInt(0)),
    ])
}

export function decodeSetValidatorPhaseRequest(
    buffer: Buffer,
): SetValidatorPhaseRequestPayload {
    let offset = 0

    const phase = PrimitiveDecoder.decodeUInt8(buffer, offset)
    offset += phase.bytesRead

    const seed = decodeHexBytes(buffer, offset)
    offset += seed.bytesRead

    const blockRef = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += blockRef.bytesRead

    return {
        phase: phase.value,
        seed: seed.value,
        blockRef: blockRef.value,
    }
}

export interface SetValidatorPhaseResponsePayload {
    status: number
    greenlight: boolean
    timestamp: bigint
    blockRef: bigint
    metadata?: unknown
}

export function encodeSetValidatorPhaseResponse(
    payload: SetValidatorPhaseResponsePayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeBoolean(payload.greenlight ?? false),
        PrimitiveEncoder.encodeUInt64(payload.timestamp ?? BigInt(0)),
        PrimitiveEncoder.encodeUInt64(payload.blockRef ?? BigInt(0)),
        PrimitiveEncoder.encodeVarBytes(
            Buffer.from(JSON.stringify(payload.metadata ?? null), "utf8"),
        ),
    ])
}

// REVIEW: Client-side decoder for setValidatorPhase responses
export function decodeSetValidatorPhaseResponse(
    buffer: Buffer,
): SetValidatorPhaseResponsePayload {
    let offset = 0

    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const greenlight = PrimitiveDecoder.decodeBoolean(buffer, offset)
    offset += greenlight.bytesRead

    const timestamp = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += timestamp.bytesRead

    const blockRef = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += blockRef.bytesRead

    const metadataBytes = PrimitiveDecoder.decodeVarBytes(buffer, offset)
    offset += metadataBytes.bytesRead

    let metadata: unknown = null
    try {
        metadata = JSON.parse(metadataBytes.value.toString("utf8"))
    } catch {
        metadata = null
    }

    return {
        status: status.value,
        greenlight: greenlight.value,
        timestamp: timestamp.value,
        blockRef: blockRef.value,
        metadata,
    }
}

export interface GreenlightRequestPayload {
    blockRef: bigint
    timestamp: bigint
    phase: number
}

// REVIEW: Client-side encoder for greenlight requests
export function encodeGreenlightRequest(
    payload: GreenlightRequestPayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt64(payload.blockRef ?? BigInt(0)),
        PrimitiveEncoder.encodeUInt64(payload.timestamp ?? BigInt(0)),
        PrimitiveEncoder.encodeUInt8(payload.phase ?? 0),
    ])
}

export function decodeGreenlightRequest(
    buffer: Buffer,
): GreenlightRequestPayload {
    let offset = 0

    const blockRef = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += blockRef.bytesRead

    const timestamp = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += timestamp.bytesRead

    const phase = PrimitiveDecoder.decodeUInt8(buffer, offset)
    offset += phase.bytesRead

    return {
        blockRef: blockRef.value,
        timestamp: timestamp.value,
        phase: phase.value,
    }
}

export interface GreenlightResponsePayload {
    status: number
    accepted: boolean
}

export function encodeGreenlightResponse(
    payload: GreenlightResponsePayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeBoolean(payload.accepted ?? false),
    ])
}

// REVIEW: Client-side decoder for greenlight responses
export function decodeGreenlightResponse(
    buffer: Buffer,
): GreenlightResponsePayload {
    let offset = 0

    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const accepted = PrimitiveDecoder.decodeBoolean(buffer, offset)
    offset += accepted.bytesRead

    return {
        status: status.value,
        accepted: accepted.value,
    }
}

export interface BlockTimestampResponsePayload {
    status: number
    timestamp: bigint
    metadata?: unknown
}

export function encodeBlockTimestampResponse(
    payload: BlockTimestampResponsePayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeUInt64(payload.timestamp ?? BigInt(0)),
        PrimitiveEncoder.encodeVarBytes(
            Buffer.from(JSON.stringify(payload.metadata ?? null), "utf8"),
        ),
    ])
}

export interface ValidatorPhaseResponsePayload {
    status: number
    hasPhase: boolean
    phase: number
    metadata?: unknown
}

export function encodeValidatorPhaseResponse(
    payload: ValidatorPhaseResponsePayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeBoolean(payload.hasPhase ?? false),
        PrimitiveEncoder.encodeUInt8(payload.phase ?? 0),
        PrimitiveEncoder.encodeVarBytes(
            Buffer.from(JSON.stringify(payload.metadata ?? null), "utf8"),
        ),
    ])
}
