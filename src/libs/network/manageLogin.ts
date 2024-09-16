import { RPCResponse, BrowserRequest } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "./server_rpc"
import { normalizeWebBuffers } from "src/libs/network/routines/normalizeWebBuffers"
import Sessions from "./routines/sessionManager"
import _ from "lodash"


export async function handleLoginResponse(
    content: BrowserRequest,
): Promise<RPCResponse> {
    let response: RPCResponse = _.cloneDeep(emptyResponse)
    let result = [true, ""]
    let s_signature = content.data.signature // Must be a JSON or a string of a signature (as Uint8Array or {type: "Buffer", data: []})
    let signature_conversion = normalizeWebBuffers(s_signature)
    let signature = signature_conversion[0]
    if (!signature) {
        response.result = 400
        response.response = "error"
        response.require_reply = true
        response.extra = "Invalid signature"
        return response
    }
    // TODO Check session validity
    // INFO When a user logs in, the server will store and send a token valid for X time
    // the user possessing that token will be able to demonstrate that the user is still logged in
    // even in 3rd party applications.
    // In any case, by calling loginRequest any application is able to enforce the user to log in
    // and verify themselves again.
    response.result = 200
    response.response = "success"
    response.require_reply = true
    response.extra = "Login successful"
    return response
}

export async function handleLoginRequest(
    content: BrowserRequest,
): Promise<RPCResponse> {
    let response: RPCResponse = _.cloneDeep(emptyResponse)
    // A browser login request is the first step for a user to confirm their identity
    // The user will be prompted for a message to sign and their session is either created or updated
    let address_requested = content.data.publicKey // Must be a JSON string of a publicKey
    let session = Sessions.getInstance().newSession(address_requested)
    if (!session) {
        response.result = 400
        response.response = "error"
        response.require_reply = true
        response.extra = "Invalid session"
        return response
    }
    response.result = 200
    response.response = "success"
    response.require_reply = true
    response.extra = "Login successful"
    return response
}