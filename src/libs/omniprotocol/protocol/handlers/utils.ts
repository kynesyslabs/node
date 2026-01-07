import { RPCResponse } from "@kynesyslabs/demosdk/types"

import { encodeRpcResponse } from "../../serialization/jsonEnvelope"

export function successResponse(response: unknown): RPCResponse {
    return {
        result: 200,
        response,
        require_reply: false,
        extra: null,
    }
}

export function errorResponse(
    status: number,
    message: string,
    extra: unknown = null,
): RPCResponse {
    return {
        result: status,
        response: message,
        require_reply: false,
        extra,
    }
}

export function encodeResponse(response: RPCResponse): Buffer {
    return encodeRpcResponse(response)
}

