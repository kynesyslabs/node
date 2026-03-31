import { RPCResponse } from "@kynesyslabs/demosdk/types"

import { PrimitiveDecoder, PrimitiveEncoder } from "./primitives"

interface EnvelopeBody {
    response: unknown
    require_reply?: boolean
    extra?: unknown
}

export function encodeRpcResponse(response: RPCResponse): Buffer {
    const status = PrimitiveEncoder.encodeUInt16(response.result)
    const body: EnvelopeBody = {
        response: response.response,
        require_reply: response.require_reply,
        extra: response.extra,
    }

    const json = Buffer.from(JSON.stringify(body), "utf8")
    const length = PrimitiveEncoder.encodeUInt32(json.length)

    return Buffer.concat([status, length, json])
}

export function decodeRpcResponse(buffer: Buffer): RPCResponse {
    let offset = 0
    const status = PrimitiveDecoder.decodeUInt16(buffer, offset)
    offset += status.bytesRead

    const length = PrimitiveDecoder.decodeUInt32(buffer, offset)
    offset += length.bytesRead

    const body = buffer.subarray(offset, offset + length.value)
    const envelope = JSON.parse(body.toString("utf8")) as EnvelopeBody

    return {
        result: status.value,
        response: envelope.response,
        require_reply: envelope.require_reply ?? false,
        extra: envelope.extra ?? null,
    }
}

export function encodeJsonRequest(payload: unknown): Buffer {
    const json = Buffer.from(JSON.stringify(payload), "utf8")
    const length = PrimitiveEncoder.encodeUInt32(json.length)
    return Buffer.concat([length, json])
}

export function decodeJsonRequest<T = unknown>(buffer: Buffer): T {
    const length = PrimitiveDecoder.decodeUInt32(buffer, 0)
    const json = buffer.subarray(
        length.bytesRead,
        length.bytesRead + length.value,
    )
    return JSON.parse(json.toString("utf8")) as T
}
