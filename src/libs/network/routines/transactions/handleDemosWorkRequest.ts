import log from "src/utilities/logger"
import { DemoScript } from "@kynesyslabs/demosdk/types"
import { DemosWork } from "@kynesyslabs/demosdk/demoswork"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "../../server_rpc"
import _ from "lodash"

export default async function handleDemosWorkRequest(
    content: DemoScript,
): Promise<RPCResponse> {
    let response: RPCResponse = _.cloneDeep(emptyResponse)
    log.info("[handleDemosWOrkRequest] Received a DemoScript: " + JSON.stringify(content))
    // TODO Implement the logic for demosWork
    response.result = 400
    response.response = "not yet implemented"
    response.extra = "Your request has been received but DemosWork logic is not implemented yet"
    return response
}