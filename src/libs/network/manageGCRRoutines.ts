import { emptyResponse } from "./server_rpc"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import IdentityManager from "../blockchain/gcr/gcr_routines/identityManager"

interface GCRRoutinePayload {
    method: string
    params: any[] // ? Define the params type or nah
}

export default async function manageGCRRoutines(
    payload: GCRRoutinePayload,
): Promise<RPCResponse> {
    let response = _.cloneDeep(emptyResponse)
    // Handle the payload
    const { method, params } = payload
    switch (method) {
        case "identity_assign_from_write":
            response.response = await IdentityManager.inferIdentityFromWrite(
                params[0],
            )
            break
        case "identity_assign_from_signature":
            response.response =
                await IdentityManager.inferIdentityFromSignature(params[0])
            break
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
