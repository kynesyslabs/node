import { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import IdentityManager from "../blockchain/gcr/gcr_routines/identityManager"
import { emptyResponse } from "./server_rpc"
import { IncentiveManager } from "../blockchain/gcr/gcr_routines/IncentiveManager"
import { SecurityManager } from "../blockchain/gcr/gcr_routines/SecurityManager"

interface GCRRoutinePayload {
    method: string
    params: any[] // ? Define the params type or nah
}

export default async function manageGCRRoutines(
    sender: string,
    payload: GCRRoutinePayload,
): Promise<RPCResponse> {
    const response = _.cloneDeep(emptyResponse)
    response.result = 200
    // Handle the payload
    const { method, params } = payload

    switch (method) {
        // SECTION XM Identity Management

        case "identity_assign_from_write":
            response.response = await IdentityManager.inferIdentityFromWrite(
                params[0],
            )
            break

        case "getIdentities":
            response.response = await IdentityManager.getIdentities(sender)
            break

        case "getWeb2Identities":
            response.response = await IdentityManager.getIdentities(
                sender,
                "web2",
            )
            break

        case "getXmIdentities":
            response.response = await IdentityManager.getIdentities(
                sender,
                "xm",
            )
            break

        case "getPoints":
            response.response = await IncentiveManager.getPoints(sender)
            break

        case "verifyTurnstile":
            response.response = await SecurityManager.verifyTurnstile(params[0])
            break

        // SECTION Web2 Identity Management

        default:
            response.response = false
            break
    }

    // Check if the response is valid
    if (response.response === false) {
        response.result = 400
        response.extra = "Payload failed to execute"
    }

    return response
}
