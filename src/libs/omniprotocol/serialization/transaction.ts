import { PrimitiveDecoder, PrimitiveEncoder } from "./primitives"

function toBigInt(value: unknown): bigint {
    if (typeof value === "bigint") return value
    if (typeof value === "number") return BigInt(Math.max(0, Math.floor(value)))
    if (typeof value === "string") {
        try {
            if (value.trim().startsWith("0x")) {
                return BigInt(value.trim())
            }
            return BigInt(value.trim())
        } catch {
            return 0n
        }
    }
    return 0n
}

function encodeStringArray(values: string[] = []): Buffer {
    const parts: Buffer[] = [PrimitiveEncoder.encodeUInt16(values.length)]
    for (const value of values) {
        parts.push(PrimitiveEncoder.encodeString(value ?? ""))
    }
    return Buffer.concat(parts)
}

function encodeGcrEdits(edits: Array<{ key?: string; value?: string }> = []): Buffer {
    const parts: Buffer[] = [PrimitiveEncoder.encodeUInt16(edits.length)]
    for (const edit of edits) {
        parts.push(PrimitiveEncoder.encodeString(edit?.key ?? ""))
        parts.push(PrimitiveEncoder.encodeString(edit?.value ?? ""))
    }
    return Buffer.concat(parts)
}

export interface DecodedTransaction {
    hash: string
    type: number
    from: string
    fromED25519: string
    to: string
    amount: bigint
    data: string[]
    gcrEdits: Array<{ key: string; value: string }>
    nonce: bigint
    timestamp: bigint
    fees: { base: bigint; priority: bigint; total: bigint }
    signature: { type: string; data: string }
    raw: Record<string, unknown>
}

export function encodeTransaction(transaction: any): Buffer {
    const content = transaction?.content ?? {}
    const fees = content?.fees ?? transaction?.fees ?? {}
    const signature = transaction?.signature ?? {}

    const orderedData = Array.isArray(content?.data)
        ? content.data.map((item: unknown) => String(item))
        : []

    const edits = Array.isArray(content?.gcr_edits)
        ? (content.gcr_edits as Array<{ key?: string; value?: string }>)
        : []

    return Buffer.concat([
        PrimitiveEncoder.encodeUInt8(
            typeof content?.type === "number" ? content.type : 0,
        ),
        PrimitiveEncoder.encodeString(content?.from ?? ""),
        PrimitiveEncoder.encodeString(content?.fromED25519 ?? ""),
        PrimitiveEncoder.encodeString(content?.to ?? ""),
        PrimitiveEncoder.encodeUInt64(toBigInt(content?.amount)),
        encodeStringArray(orderedData),
        encodeGcrEdits(edits),
        PrimitiveEncoder.encodeUInt64(toBigInt(content?.nonce ?? transaction?.nonce)),
        PrimitiveEncoder.encodeUInt64(
            toBigInt(content?.timestamp ?? transaction?.timestamp),
        ),
        PrimitiveEncoder.encodeUInt64(toBigInt(fees?.base)),
        PrimitiveEncoder.encodeUInt64(toBigInt(fees?.priority)),
        PrimitiveEncoder.encodeUInt64(toBigInt(fees?.total)),
        PrimitiveEncoder.encodeString(signature?.type ?? ""),
        PrimitiveEncoder.encodeString(signature?.data ?? ""),
        PrimitiveEncoder.encodeString(transaction?.hash ?? ""),
        PrimitiveEncoder.encodeVarBytes(
            Buffer.from(JSON.stringify(transaction ?? {}), "utf8"),
        ),
    ])
}

export function decodeTransaction(buffer: Buffer): DecodedTransaction {
    let offset = 0

    const type = PrimitiveDecoder.decodeUInt8(buffer, offset)
    offset += type.bytesRead

    const from = PrimitiveDecoder.decodeString(buffer, offset)
    offset += from.bytesRead

    const fromED25519 = PrimitiveDecoder.decodeString(buffer, offset)
    offset += fromED25519.bytesRead

    const to = PrimitiveDecoder.decodeString(buffer, offset)
    offset += to.bytesRead

    const amount = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += amount.bytesRead

    const dataCount = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += dataCount.bytesRead

    const data: string[] = []
    for (let i = 0; i < dataCount.value; i++) {
        const entry = PrimitiveDecoder.decodeString(buffer, offset)
        offset += entry.bytesRead
        data.push(entry.value)
    }

    const editsCount = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += editsCount.bytesRead

    const gcrEdits: Array<{ key: string; value: string }> = []
    for (let i = 0; i < editsCount.value; i++) {
        const key = PrimitiveDecoder.decodeString(buffer, offset)
        offset += key.bytesRead
        const value = PrimitiveDecoder.decodeString(buffer, offset)
        offset += value.bytesRead
        gcrEdits.push({ key: key.value, value: value.value })
    }

    const nonce = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += nonce.bytesRead

    const timestamp = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += timestamp.bytesRead

    const feeBase = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += feeBase.bytesRead

    const feePriority = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += feePriority.bytesRead

    const feeTotal = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += feeTotal.bytesRead

    const sigType = PrimitiveDecoder.decodeString(buffer, offset)
    offset += sigType.bytesRead

    const sigData = PrimitiveDecoder.decodeString(buffer, offset)
    offset += sigData.bytesRead

    const hash = PrimitiveDecoder.decodeString(buffer, offset)
    offset += hash.bytesRead

    const rawBytes = PrimitiveDecoder.decodeVarBytes(buffer, offset)
    offset += rawBytes.bytesRead

    let raw: Record<string, unknown> = {}
    try {
        raw = JSON.parse(rawBytes.value.toString("utf8")) as Record<string, unknown>
    } catch {
        raw = {}
    }

    return {
        hash: hash.value,
        type: type.value,
        from: from.value,
        fromED25519: fromED25519.value,
        to: to.value,
        amount: amount.value,
        data,
        gcrEdits,
        nonce: nonce.value,
        timestamp: timestamp.value,
        fees: {
            base: feeBase.value,
            priority: feePriority.value,
            total: feeTotal.value,
        },
        signature: {
            type: sigType.value,
            data: sigData.value,
        },
        raw,
    }
}

export interface TransactionEnvelopePayload {
    status: number
    transaction: Buffer
}

export function encodeTransactionEnvelope(payload: TransactionEnvelopePayload): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeVarBytes(payload.transaction),
    ])
}

export function decodeTransactionEnvelope(buffer: Buffer): {
    status: number
    transaction: DecodedTransaction
} {
    let offset = 0
    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const txBytes = PrimitiveDecoder.decodeVarBytes(buffer, offset)
    offset += txBytes.bytesRead

    return {
        status: status.value,
        transaction: decodeTransaction(txBytes.value),
    }
}
