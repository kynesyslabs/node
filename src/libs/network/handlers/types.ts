import { RPCResponse } from "@kynesyslabs/demosdk/types"

export type NodeCallHandler = (
    data: any,
    response: RPCResponse,
) => Promise<RPCResponse>
