import ComLink from "../communications/comlink"
import { comlinkUtils } from "../communications"
import { BundleContent } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import * as forge from "node-forge"
import ServerHandlers from "./endpointHandlers"
import { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import { ISecurityReport } from "@kynesyslabs/demosdk/types"
import * as Security from "src/libs/network/securityModule"
import sharedState from "src/utilities/sharedState"
import manageMessages from "src/libs/network/routines/manageMessages"
import { RPCResponse } from "./server_rpc"

/* INFO for the transition to RPC
- We need to return a RPCResponse object instead of a ComLink object
- We need to use the comlinkUtils.replyToComlink method to inscript a response in the registry and to get
    the RPC compliant response to send back to server_rpc logic
*/

import terminalkit from "terminal-kit"

const term = terminalkit.terminal

// This method is used to check the comlink before processing it
export async function preflightComLinkChecks(request: any): Promise<{
    _comlink_request: ComLink
    content: BundleContent
    id_ed25519: forge.pki.KeyPair
}> {
    term.yellow("[SERVER] Received comlink: " + request.muid + "\n")
    //console.log(request)
    const id_ed25519 = sharedState.getInstance().identity.ed25519
    let _comlink_request: ComLink
    // TODO This can be put into securityModule for consistency
    try {
        // Parsing comlink
        _comlink_request = await comlinkUtils.parseComlink(
            request,
        )
        if (!_comlink_request) {
            let error =
                "Error while parsing comlink request\nComlink: " +
                JSON.stringify(request)
            log.error(error)
            return null // TODO Better error handling
        }
    } catch (e) {
        let error = "Error while parsing comlink request: " + e
        log.error(error)
        console.log("Returning")
        return null // TODO Better error handling
    }
    // We can now extract the comlink and the content to be used in the handlers
    console.log(
        "[serverListeners] ComLink request received and parsed correctly",
    )

    let content: BundleContent =
        _comlink_request.chain.current.currentMessage.bundle.content
    return { _comlink_request, content, id_ed25519 }
}

// Here, we manage the comlink and its content
export default async function manageComLink(request: any): Promise<RPCResponse> {
    // Security and sanity checks
    let _comlink_request: ComLink
    let content: BundleContent
    let id_ed25519: forge.pki.KeyPair
    try {
        ({ _comlink_request, content, id_ed25519 } =
            await preflightComLinkChecks(request))
    } catch (e) {
        log.error("Error while managing comlink: " + e)
        return null
    }
    //console.log(_comlink_request)
    // NOTE Now we have a valid ComLink and we can work with it
    console.log("[serverListeners] Received comlink content")

    let extra: any, require_reply: any, response: any

    console.log("[serverListeners] content.type: " + content.type)
    console.log("[serverListeners] content.extra: " + content.extra)

    if (content.type === "l2ps") {
        let response = await ServerHandlers.handleL2PS( // ! This should return a RPCResponse
            content,
        )
        if (response.result !== 200) {
            term.red.bold(
                "[SERVER] Error while handling L2PS request, aborting",
            )
        }
        // Sending back the response // REVIEW Experimental
        let rpcResponse: RPCResponse = await comlinkUtils.replyToComlink(_comlink_request, response)
        return rpcResponse
    }

    
    // TODO Better to modularize this
    // REVIEW We use the 'extra' field to see if it is a confirmTx request (prior to execution)
    // or an broadcastTx request (to execute the transaction after gas cost is calculated).
    // Transactions are either gas consuming or not, so we need to check if the transaction
    // needs to be validated,executed or treated as a message.
    switch (content.extra) {
        // ANCHOR Gas consuming transactions
        // Validating a tx means that we calculate gas and check if the transaction is valid
        // Then we send the validation data to the client that can use it to execute the tx
        case "confirmTx":
            term.yellow.bold("[SERVER] Received confirmTx\n")
            var validityData = await ServerHandlers.handleValidateTransaction(
                content.data as Transaction,
            )
            response = validityData
            extra = ""
            require_reply = false // REVIEW Should we require a reply here?

            // console.log(response)

            break
        // Executing a tx means that we execute the transaction and send back the result
        // to the client. We first need to check if the tx is actually valid.
        case "broadcastTx":
            term.yellow.bold("[SERVER] Received broadcastTx\n")
            // REVIEW This method needs to actually verify if the transaction is valid
            var result = await ServerHandlers.handleExecuteTransaction(
                content.data as ValidityData,
            ) // ! This shouldn't care about the socket as there isnt anymore
            // Destructuring the result to get the extra, require_reply and response
            ;({ extra, require_reply, response } = result)
            break
        // ANCHOR Messages
        // All the rest of the comlink types do not require extra validation or gas calculation
        // They are treated as messages and are handled by their types themselves
        // For readability, we call an external function to manage the messages
        default:
            ({ extra, require_reply, response } = await manageMessages(
                content,
                _comlink_request,
                request,
                id_ed25519,
            )) // ! This shouldn't care about the socket as there isnt anymore
            break
    }
    //console.log("content.message: " + content.message)
    //console.log("content.message.action: " + content.message.action)

    // ANCHOR Reply logic

    // TODO & REVIEW Call security module for send limiting messages
    let secDisabled = true
    if (!secDisabled) {
        let ts = new Date().getTime()
        let securityInterceptor: ISecurityReport =
            await Security.modules.communications.comlink.checkRateLimits(ts)
        if (!securityInterceptor.state) {
            switch (securityInterceptor.code) {
                case "429":
                    break

                default:
                    term.red.bold(
                        "[COMLINK] [SECURITY INTERCEPTOR] Unknown error: " +
                            securityInterceptor.code.toString(),
                    )
                    term.red.bold("[COMLINK] [SECURITY INTERCEPTOR] Reported:")
                    console.log(securityInterceptor.message)
                    break
            }
        }
    }

    // Sending back the response
    console.log("[SERVER] Sending back comlink")
    // NOTE unless specified, we now send back the updated comlink as a response
    let rpcResponse: RPCResponse = await comlinkUtils.replyToComlink(_comlink_request, response)
    return rpcResponse
}
