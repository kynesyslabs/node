import { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import RubicService from "../../features/bridges/rubic"
import { emptyResponse } from "./server_rpc"
import { WrappedCrossChainTrade } from "rubic-sdk"

interface BridgePayload {
    method: string
    chain: string
    params: any[] // ? Define the params type or nah
}

export default async function manageBridges(
    sender: string,
    payload: BridgePayload,
): Promise<RPCResponse> {
    const response = _.cloneDeep(emptyResponse)
    response.result = 200

    const { method, params } = payload

    switch (method) {
        case "get_trade":
            response.response = await RubicService.getQuoteFromApi(params[0])
            break

        case "execute_trade": {
            response.response = await RubicService.getSwapDataFromApi(params[0])
            break
        }

        default:
            response.response = false
            break
    }

    if (response.response === false) {
        response.result = 400
        response.extra = "Payload failed to execute"
    }

    return response
}
