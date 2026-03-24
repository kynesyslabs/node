import { PrimitiveDecoder, PrimitiveEncoder } from "./primitives"

export interface MempoolResponsePayload {
    status: number
    transactions: Buffer[]
}

export function encodeMempoolResponse(payload: MempoolResponsePayload): Buffer {
    const parts: Buffer[] = []
    parts.push(PrimitiveEncoder.encodeUInt16(payload.status))
    parts.push(PrimitiveEncoder.encodeUInt16(payload.transactions.length))

    for (const tx of payload.transactions) {
        parts.push(PrimitiveEncoder.encodeVarBytes(tx))
    }

    return Buffer.concat(parts)
}

export function decodeMempoolResponse(buffer: Buffer): MempoolResponsePayload {
    let offset = 0
    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += count.bytesRead

    const transactions: Buffer[] = []

    for (let i = 0; i < count.value; i++) {
        const tx = PrimitiveDecoder.decodeVarBytes(buffer, offset)
        offset += tx.bytesRead
        transactions.push(tx.value)
    }

    return { status: status.value, transactions }
}

export interface MempoolSyncRequestPayload {
    txCount: number
    mempoolHash: Buffer
    blockReference: bigint
}

export function encodeMempoolSyncRequest(
    payload: MempoolSyncRequestPayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.txCount),
        PrimitiveEncoder.encodeBytes(payload.mempoolHash),
        PrimitiveEncoder.encodeUInt64(payload.blockReference),
    ])
}

export function decodeMempoolSyncRequest(
    buffer: Buffer,
): MempoolSyncRequestPayload {
    let offset = 0
    const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += count.bytesRead

    const hash = PrimitiveDecoder.decodeBytes(buffer, offset)
    offset += hash.bytesRead

    const blockRef = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += blockRef.bytesRead

    return {
        txCount: count.value,
        mempoolHash: hash.value,
        blockReference: blockRef.value,
    }
}

export interface MempoolSyncResponsePayload {
    status: number
    txCount: number
    mempoolHash: Buffer
    transactionHashes: Buffer[]
}

export function encodeMempoolSyncResponse(
    payload: MempoolSyncResponsePayload,
): Buffer {
    const parts: Buffer[] = []

    parts.push(PrimitiveEncoder.encodeUInt16(payload.status))
    parts.push(PrimitiveEncoder.encodeUInt16(payload.txCount))
    parts.push(PrimitiveEncoder.encodeBytes(payload.mempoolHash))
    parts.push(PrimitiveEncoder.encodeUInt16(payload.transactionHashes.length))

    for (const hash of payload.transactionHashes) {
        parts.push(PrimitiveEncoder.encodeBytes(hash))
    }

    return Buffer.concat(parts)
}

export interface MempoolMergeRequestPayload {
    transactions: Buffer[]
}

export function decodeMempoolMergeRequest(
    buffer: Buffer,
): MempoolMergeRequestPayload {
    let offset = 0
    const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += count.bytesRead

    const transactions: Buffer[] = []
    for (let i = 0; i < count.value; i++) {
        const tx = PrimitiveDecoder.decodeVarBytes(buffer, offset)
        offset += tx.bytesRead
        transactions.push(tx.value)
    }

    return { transactions }
}

export function encodeMempoolMergeRequest(
    payload: MempoolMergeRequestPayload,
): Buffer {
    const parts: Buffer[] = []
    parts.push(PrimitiveEncoder.encodeUInt16(payload.transactions.length))

    for (const tx of payload.transactions) {
        parts.push(PrimitiveEncoder.encodeVarBytes(tx))
    }

    return Buffer.concat(parts)
}

export function decodeMempoolSyncResponse(
    buffer: Buffer,
): MempoolSyncResponsePayload {
    let offset = 0
    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const txCount = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += txCount.bytesRead

    const memHash = PrimitiveDecoder.decodeBytes(buffer, offset)
    offset += memHash.bytesRead

    const missingCount = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += missingCount.bytesRead

    const hashes: Buffer[] = []
    for (let i = 0; i < missingCount.value; i++) {
        const hash = PrimitiveDecoder.decodeBytes(buffer, offset)
        offset += hash.bytesRead
        hashes.push(hash.value)
    }

    return {
        status: status.value,
        txCount: txCount.value,
        mempoolHash: memHash.value,
        transactionHashes: hashes,
    }
}

export interface BlockEntryPayload {
    blockNumber: bigint
    blockHash: string
    timestamp: bigint
    metadata: Buffer
}

export interface BlockMetadata {
    previousHash: string
    proposer: string
    nextProposer: string
    status: string
    transactionHashes: string[]
}

function encodeStringArray(values: string[]): Buffer {
    const parts: Buffer[] = [PrimitiveEncoder.encodeUInt16(values.length)]
    for (const value of values) {
        parts.push(PrimitiveEncoder.encodeString(value ?? ""))
    }
    return Buffer.concat(parts)
}

function decodeStringArray(
    buffer: Buffer,
    offset: number,
): {
    values: string[]
    bytesRead: number
} {
    const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
    let cursor = offset + count.bytesRead
    const values: string[] = []
    for (let i = 0; i < count.value; i++) {
        const entry = PrimitiveDecoder.decodeString(buffer, cursor)
        cursor += entry.bytesRead
        values.push(entry.value)
    }
    return { values, bytesRead: cursor - offset }
}

export function encodeBlockMetadata(metadata: BlockMetadata): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeString(metadata.previousHash ?? ""),
        PrimitiveEncoder.encodeString(metadata.proposer ?? ""),
        PrimitiveEncoder.encodeString(metadata.nextProposer ?? ""),
        PrimitiveEncoder.encodeString(metadata.status ?? ""),
        encodeStringArray(metadata.transactionHashes ?? []),
    ])
}

export function decodeBlockMetadata(buffer: Buffer): BlockMetadata {
    let offset = 0
    const previousHash = PrimitiveDecoder.decodeString(buffer, offset)
    offset += previousHash.bytesRead

    const proposer = PrimitiveDecoder.decodeString(buffer, offset)
    offset += proposer.bytesRead

    const nextProposer = PrimitiveDecoder.decodeString(buffer, offset)
    offset += nextProposer.bytesRead

    const status = PrimitiveDecoder.decodeString(buffer, offset)
    offset += status.bytesRead

    const hashes = decodeStringArray(buffer, offset)
    offset += hashes.bytesRead

    return {
        previousHash: previousHash.value,
        proposer: proposer.value,
        nextProposer: nextProposer.value,
        status: status.value,
        transactionHashes: hashes.values,
    }
}

function encodeBlockEntry(entry: BlockEntryPayload): Buffer {
    const hashBytes = Buffer.from(entry.blockHash.replace(/^0x/, ""), "hex")

    return Buffer.concat([
        PrimitiveEncoder.encodeUInt64(entry.blockNumber),
        PrimitiveEncoder.encodeBytes(hashBytes),
        PrimitiveEncoder.encodeUInt64(entry.timestamp),
        PrimitiveEncoder.encodeVarBytes(entry.metadata),
    ])
}

function decodeBlockEntry(
    buffer: Buffer,
    offset: number,
): { entry: BlockEntryPayload; bytesRead: number } {
    let cursor = offset

    const blockNumber = PrimitiveDecoder.decodeUInt64(buffer, cursor)
    cursor += blockNumber.bytesRead

    const hash = PrimitiveDecoder.decodeBytes(buffer, cursor)
    cursor += hash.bytesRead

    const timestamp = PrimitiveDecoder.decodeUInt64(buffer, cursor)
    cursor += timestamp.bytesRead

    const metadata = PrimitiveDecoder.decodeVarBytes(buffer, cursor)
    cursor += metadata.bytesRead

    return {
        entry: {
            blockNumber: blockNumber.value,
            blockHash: `0x${hash.value.toString("hex")}`,
            timestamp: timestamp.value,
            metadata: metadata.value,
        },
        bytesRead: cursor - offset,
    }
}

export interface BlockResponsePayload {
    status: number
    block: BlockEntryPayload
}

export function encodeBlockResponse(payload: BlockResponsePayload): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        encodeBlockEntry(payload.block),
    ])
}

export function decodeBlockResponse(buffer: Buffer): BlockResponsePayload {
    let offset = 0
    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const { entry, bytesRead } = decodeBlockEntry(buffer, offset)
    offset += bytesRead

    return {
        status: status.value,
        block: entry,
    }
}

export interface BlocksResponsePayload {
    status: number
    blocks: BlockEntryPayload[]
}

export function encodeBlocksResponse(payload: BlocksResponsePayload): Buffer {
    const parts: Buffer[] = []
    parts.push(PrimitiveEncoder.encodeUInt16(payload.status))
    parts.push(PrimitiveEncoder.encodeUInt16(payload.blocks.length))

    for (const block of payload.blocks) {
        parts.push(encodeBlockEntry(block))
    }

    return Buffer.concat(parts)
}

export function decodeBlocksResponse(buffer: Buffer): BlocksResponsePayload {
    let offset = 0
    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const count = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += count.bytesRead

    const blocks: BlockEntryPayload[] = []
    for (let i = 0; i < count.value; i++) {
        const { entry, bytesRead } = decodeBlockEntry(buffer, offset)
        blocks.push(entry)
        offset += bytesRead
    }

    return {
        status: status.value,
        blocks,
    }
}

export interface BlockSyncRequestPayload {
    startBlock: bigint
    endBlock: bigint
    maxBlocks: number
}

export function decodeBlockSyncRequest(
    buffer: Buffer,
): BlockSyncRequestPayload {
    let offset = 0
    const start = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += start.bytesRead

    const end = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += end.bytesRead

    const max = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += max.bytesRead

    return {
        startBlock: start.value,
        endBlock: end.value,
        maxBlocks: max.value,
    }
}

export function encodeBlockSyncRequest(
    payload: BlockSyncRequestPayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt64(payload.startBlock),
        PrimitiveEncoder.encodeUInt64(payload.endBlock),
        PrimitiveEncoder.encodeUInt16(payload.maxBlocks),
    ])
}

export interface BlockSyncResponsePayload {
    status: number
    blocks: BlockEntryPayload[]
}

export function encodeBlockSyncResponse(
    payload: BlockSyncResponsePayload,
): Buffer {
    return encodeBlocksResponse({
        status: payload.status,
        blocks: payload.blocks,
    })
}

export interface BlocksRequestPayload {
    startBlock: bigint
    limit: number
}

export function decodeBlocksRequest(buffer: Buffer): BlocksRequestPayload {
    let offset = 0
    const start = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += start.bytesRead

    const limit = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += limit.bytesRead

    return {
        startBlock: start.value,
        limit: limit.value,
    }
}

export function encodeBlocksRequest(payload: BlocksRequestPayload): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt64(payload.startBlock),
        PrimitiveEncoder.encodeUInt16(payload.limit),
    ])
}

export interface BlockHashRequestPayload {
    hash: Buffer
}

export function decodeBlockHashRequest(
    buffer: Buffer,
): BlockHashRequestPayload {
    const hash = PrimitiveDecoder.decodeBytes(buffer, 0)
    return { hash: hash.value }
}

export interface TransactionHashRequestPayload {
    hash: Buffer
}

export function decodeTransactionHashRequest(
    buffer: Buffer,
): TransactionHashRequestPayload {
    const hash = PrimitiveDecoder.decodeBytes(buffer, 0)
    return { hash: hash.value }
}

export interface TransactionResponsePayload {
    status: number
    transaction: Buffer
}

export function encodeTransactionResponse(
    payload: TransactionResponsePayload,
): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeVarBytes(payload.transaction),
    ])
}
