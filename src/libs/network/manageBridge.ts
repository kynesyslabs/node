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

    const { method, chain, params } = payload
    const rubicService = new RubicService(sender, chain)
    await rubicService.waitForInitialization()

    switch (method) {
        case "get_trade":
            response.response = await rubicService.getTrade(params[0])
            break

        case "execute_trade": {
            const trade = await rubicService.getTrade(params[0])

            if (trade instanceof Error) {
                console.error("Trade error:", trade)
                response.response = false
                break
            }

            response.response = await rubicService.executeTrade(trade)
            break
        }

        case "execute_mock_trade": {
            const mockTrade = params[0] as WrappedCrossChainTrade
            ;(mockTrade.trade.swap = async () => "0x1234567890abcdef"),
                (mockTrade.trade.needApprove = async () => false),
                (response.response = await rubicService.executeTrade(mockTrade))
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
