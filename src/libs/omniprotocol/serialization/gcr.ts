import { PrimitiveDecoder, PrimitiveEncoder } from "./primitives"

export interface AddressInfoPayload {
    status: number
    balance: bigint
    nonce: bigint
    additionalData: Buffer
}

export function encodeAddressInfoResponse(payload: AddressInfoPayload): Buffer {
    return Buffer.concat([
        PrimitiveEncoder.encodeUInt16(payload.status),
        PrimitiveEncoder.encodeUInt64(payload.balance),
        PrimitiveEncoder.encodeUInt64(payload.nonce),
        PrimitiveEncoder.encodeVarBytes(payload.additionalData),
    ])
}

export function decodeAddressInfoResponse(buffer: Buffer): AddressInfoPayload {
    let offset = 0
    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const balance = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += balance.bytesRead

    const nonce = PrimitiveDecoder.decodeUInt64(buffer, offset)
    offset += nonce.bytesRead

    const additional = PrimitiveDecoder.decodeVarBytes(buffer, offset)
    offset += additional.bytesRead

    return {
        status: status.value,
        balance: balance.value,
        nonce: nonce.value,
        additionalData: additional.value,
    }
}
