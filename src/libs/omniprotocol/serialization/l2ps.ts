import { PrimitiveDecoder, PrimitiveEncoder } from "./primitives"

// ============================================
// L2PS Request/Response Types
// ============================================

export interface L2PSSubmitEncryptedTxRequest {
    l2psUid: string
    encryptedTx: string // JSON stringified L2PSTransaction
    originalHash: string
}

export interface L2PSGetProofRequest {
    l2psUid: string
    batchHash: string
}

export interface L2PSVerifyBatchRequest {
    l2psUid: string
    batchHash: string
    proofHash: string
}

export interface L2PSSyncMempoolRequest {
    l2psUid: string
    fromTimestamp?: number
    limit?: number
}

export interface L2PSGetBatchStatusRequest {
    l2psUid: string
    batchHash?: string
}

export interface L2PSGetParticipationRequest {
    l2psUid: string
    address?: string
}

export interface L2PSHashUpdateRequest {
    l2psUid: string
    consolidatedHash: string
    transactionCount: number
    blockNumber: number
    timestamp: number
}

// ============================================
// Binary Serialization (for L2PS Hash Updates)
// ============================================

export function encodeL2PSHashUpdate(req: L2PSHashUpdateRequest): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeString(req.l2psUid),
        PrimitiveEncoder.encodeString(req.consolidatedHash),
        PrimitiveEncoder.encodeUInt32(req.transactionCount),
        PrimitiveEncoder.encodeUInt64(req.blockNumber),
        PrimitiveEncoder.encodeUInt64(req.timestamp),
    ])
}

export function decodeL2PSHashUpdate(buffer: Buffer): L2PSHashUpdateRequest {
    let offset = 0

    const l2psUid = PrimitiveDecoder.decodeString(buffer, offset)
    offset += l2psUid.bytesRead

    const consolidatedHash = PrimitiveDecoder.decodeString(buffer, offset)
    offset += consolidatedHash.bytesRead

    const transactionCount = PrimitiveDecoder.decodeUInt32(buffer, offset)
    offset += transactionCount.bytesRead

    const blockNumber = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += blockNumber.bytesRead

    const timestamp = PrimitiveDecoder.decodeUInt64(buffer, offset)

    return {
        l2psUid: l2psUid.value,
        consolidatedHash: consolidatedHash.value,
        transactionCount: transactionCount.value,
        blockNumber: Number(blockNumber.value),
        timestamp: Number(timestamp.value),
    }
}

// ============================================
// Binary Serialization (for L2PS Sync)
// ============================================

export interface L2PSMempoolEntry {
    hash: string
    l2psUid: string
    originalHash: string
    status: string
    timestamp: number
}

export function encodeL2PSMempoolEntries(entries: L2PSMempoolEntry[]): Buffer {
    const parts: Buffer[] = [PrimitiveEncoder.encodeUInt16(entries.length)]

    for (const entry of entries) {
        parts.push(PrimitiveEncoder.encodeString(entry.hash))
        parts.push(PrimitiveEncoder.encodeString(entry.l2psUid))
        parts.push(PrimitiveEncoder.encodeString(entry.originalHash))
        parts.push(PrimitiveEncoder.encodeString(entry.status))
        parts.push(PrimitiveEncoder.encodeUInt64(entry.timestamp))
    }

    return Buffer.concat(parts)
}

export function decodeL2PSMempoolEntries(buffer: Buffer): L2PSMempoolEntry[] {
    let offset = 0

    const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += count.bytesRead

    const entries: L2PSMempoolEntry[] = []

    for (let i = 0; i < count.value; i++) {
        const hash = PrimitiveDecoder.decodeString(buffer, offset)
        offset += hash.bytesRead

        const l2psUid = PrimitiveDecoder.decodeString(buffer, offset)
        offset += l2psUid.bytesRead

        const originalHash = PrimitiveDecoder.decodeString(buffer, offset)
        offset += originalHash.bytesRead

        const status = PrimitiveDecoder.decodeString(buffer, offset)
        offset += status.bytesRead

        const timestamp = PrimitiveDecoder.decodeUInt64(buffer, offset)
        offset += timestamp.bytesRead

        entries.push({
            hash: hash.value,
            l2psUid: l2psUid.value,
            originalHash: originalHash.value,
            status: status.value,
            timestamp: Number(timestamp.value),
        })
    }

    return entries
}

// ============================================
// Proof Response Serialization
// ============================================

export interface L2PSProofData {
    proofHash: string
    batchHash: string
    transactionCount: number
    status: string
    createdAt: number
}

export function encodeL2PSProofData(proof: L2PSProofData): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeString(proof.proofHash),
        PrimitiveEncoder.encodeString(proof.batchHash),
        PrimitiveEncoder.encodeUInt32(proof.transactionCount),
        PrimitiveEncoder.encodeString(proof.status),
        PrimitiveEncoder.encodeUInt64(proof.createdAt),
    ])
}

export function decodeL2PSProofData(buffer: Buffer): L2PSProofData {
    let offset = 0

    const proofHash = PrimitiveDecoder.decodeString(buffer, offset)
    offset += proofHash.bytesRead

    const batchHash = PrimitiveDecoder.decodeString(buffer, offset)
    offset += batchHash.bytesRead

    const transactionCount = PrimitiveDecoder.decodeUInt32(buffer, offset)
    offset += transactionCount.bytesRead

    const status = PrimitiveDecoder.decodeString(buffer, offset)
    offset += status.bytesRead

    const createdAt = PrimitiveDecoder.decodeUInt64(buffer, offset)

    return {
        proofHash: proofHash.value,
        batchHash: batchHash.value,
        transactionCount: transactionCount.value,
        status: status.value,
        createdAt: Number(createdAt.value),
    }
}
