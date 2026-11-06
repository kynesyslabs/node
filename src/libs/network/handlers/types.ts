import { RPCResponse } from "@kynesyslabs/demosdk/types"

export type NodeCallHandler = (
    data: any,
    response: RPCResponse,
    /** Address proven by the request's verified signature; "" if none. */
    sender: string,
) => Promise<RPCResponse>
