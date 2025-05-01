import { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import IdentityManager from "../blockchain/gcr/gcr_routines/identityManager"
import { emptyResponse } from "./server_rpc"

interface GCRRoutinePayload {
    method: string
    params: any[] // ? Define the params type or nah
}

export default async function manageGCRRoutines(
    sender: string,
    payload: GCRRoutinePayload,
): Promise<RPCResponse> {
    let response = _.cloneDeep(emptyResponse)
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

        case "identity_assign_from_signature":
            try {
                // TODO: This method is deprecated. Identities should be updated as transactions.
                // Consider replacing with a transaction-based approach
                response = await IdentityManager.inferIdentityFromSignature(
                    sender,
                    params[0],
                )
            } catch (error) {
                console.error(error)
                response.result = 400
                response.response = "Error: something went wrong"
                response.extra = error
            }
            break

        case "remove_identity":
            response = await IdentityManager.removeXmIdentity(sender, params[0])
            break

        case "getIdentities":
            // eslint-disable-next-line no-var
            var data = await IdentityManager.getXmIdentities(sender)
            response.response = {
                xm: data,
                web2: {},
            }
            break
        // SECTION Web2 Identity Management

        // Github identity add
        case "add_github_identity":
            response = await IdentityManager.addWeb2Identifier(
                sender,
                "github",
                params[0], // REVIEW Is this correct?
            )
            break

        // Twitter identity add
        case "add_twitter_identity":
            response = await IdentityManager.addWeb2Identifier(
                sender,
                "twitter",
                params[0],
            )
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
