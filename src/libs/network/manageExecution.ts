import { RPCResponse, emptyResponse } from "./server_rpc"
import { BundleContent } from "@kynesyslabs/demosdk/types"
import { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import ServerHandlers from "./endpointHandlers"
import manageMessages from "./routines/manageMessages"
import { ISecurityReport } from "@kynesyslabs/demosdk/types"
import * as Security from "src/libs/network/securityModule"
import _ from "lodash"
import terminalkit from "terminal-kit"

const term = terminalkit.terminal

export async function manageExecution(
    content: BundleContent,
): Promise<RPCResponse> {
    let return_value = _.cloneDeep(emptyResponse)
    // ! TODO Manage things here instead of comlinks possibly

    console.log("[serverListeners] content.type: " + content.type)
    console.log("[serverListeners] content.extra: " + content.extra)

    if (content.type === "l2ps") {
        let response = await ServerHandlers.handleL2PS(
            content,
        )
        if (response.result !== 200) {
            term.red.bold(
                "[SERVER] Error while handling L2PS request, aborting",
            )
        }
        return response
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
            return_value.result = 200
            return_value.response = validityData
            return_value.require_reply = false
            break
        // Executing a tx means that we execute the transaction and send back the result
        // to the client. We first need to check if the tx is actually valid.
        case "broadcastTx":
            term.yellow.bold("[SERVER] Received broadcastTx\n")
            // REVIEW This method needs to actually verify if the transaction is valid
            var result = await ServerHandlers.handleExecuteTransaction(
                content.data as ValidityData,
            ) 
            // Destructuring the result to get the extra, require_reply and response
            return_value.result = 200
            return_value.response = result.response
            return_value.require_reply = result.require_reply
            return_value.extra = result.extra
            break
        // ANCHOR Messages
        // All the rest of the comlink types do not require extra validation or gas calculation
        // They are treated as messages and are handled by their types themselves
        // For readability, we call an external function to manage the messages
        default:
            return_value = await manageMessages(
                content,
            ) // ! This shouldn't care about the socket as there isnt anymore
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
    console.log("[SERVER] Sending back a response")
    console.log(return_value)
    return return_value
}
