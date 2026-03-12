import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "./server_rpc"
import { BundleContent } from "@kynesyslabs/demosdk/types"
import { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import ServerHandlers from "./endpointHandlers"
import { ISecurityReport } from "@kynesyslabs/demosdk/types"
import * as Security from "src/libs/network/securityModule"
import _ from "lodash"
import log from "src/utilities/logger"

export async function manageExecution(
    content: BundleContent,
    sender: string,
): Promise<RPCResponse> {
    const returnValue = _.cloneDeep(emptyResponse)

    log.debug("[serverListeners] content.type: " + content.type)
    log.debug("[serverListeners] content.extra: " + content.extra)

    log.info(`[serverListeners] Received execution request for type: ${content.type}`)

    if (content.type === "l2ps" || content.type === "l2psEncryptedTx") {
        const response = await ServerHandlers.handleL2PS(content.data)
        if (response.result !== 200) {
            log.error("SERVER", "Error while handling L2PS request, aborting")
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
            log.info("SERVER", "Received confirmTx")
            // eslint-disable-next-line no-var
            var validityData = await ServerHandlers.handleValidateTransaction(
                content.data as Transaction,
                sender,
            )
            returnValue.result = 200
            returnValue.response = validityData
            returnValue.require_reply = false
            break
        // Executing a tx means that we execute the transaction and send back the result
        // to the client. We first need to check if the tx is actually valid.
        case "broadcastTx":
            log.info("SERVER", "Received broadcastTx")
            // REVIEW This method needs to actually verify if the transaction is valid

            var validityDataPayload: ValidityData
            // If content.data.response.rpc_public_key exists, we assign validityDataPayload to response
            try {
                if (content.data.response.rpc_public_key) {
                    validityDataPayload = content.data.response
                } else {
                    validityDataPayload = content.data
                }
            } catch (e) {
                validityDataPayload = content.data
            }

            try {
                const result = await ServerHandlers.handleExecuteTransaction(
                    validityDataPayload,
                    sender,
                )
                log.debug(
                    "[SERVER] Transaction executed. Sending back the result",
                )
                // Destructuring the result to get the extra, require_reply and response
                returnValue.result = result.success ? 200 : 400
                returnValue.response = result.response
                returnValue.require_reply = result.require_reply
                returnValue.extra = result.extra
                break
            } catch (error) {
                const errorMessage =
                    "[SERVER] Error while handling broadcastTx: " + error
                log.error(errorMessage)
                returnValue.result = 400
                returnValue.response = "Bad Request"
                returnValue.extra = errorMessage
                returnValue.require_reply = false
                return returnValue
            }
        // ANCHOR Messages
        // They are treated as messages and are handled by their types themselves
        // For readability, we call an external function to manage the messages
        default:
            returnValue.result = 400
            returnValue.response = "Bad Request"
            returnValue.require_reply = false
            break
    }
    //console.log("content.message: " + content.message)
    //console.log("content.message.action: " + content.message.action)

    // ANCHOR Reply logic

    // TODO & REVIEW Call security module for send limiting messages
    const secDisabled = true
    if (!secDisabled) {
        const ts = new Date().getTime()
        const securityInterceptor: ISecurityReport = null // ! implement this
    }

    // Sending back the response
    log.debug("[SERVER] Sending back a response")
    //console.log(return_value)
    return returnValue
}
