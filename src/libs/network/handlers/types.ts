import { RPCResponse } from "@kynesyslabs/demosdk/types"

export type NodeCallHandler = (
    data: any,
    response: RPCResponse,
    /** Address proven by the request's verified signature; "" if none. */
    sender: string,
    /** The caller's address as the rate limiter resolved it, when known. */
    clientIP?: string,
) => Promise<RPCResponse>
