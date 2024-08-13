/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Socket } from "socket.io-client"
import sharedState from "src/utilities/sharedState"
import sizeOf from "src/utilities/sizeOf"
import { json } from "stream/consumers"
import terminalkit from "terminal-kit"

import { DefaultEventsMap } from "@socket.io/component-emitter"

import ComLink from "./comlink"
import log from "src/utilities/logger"
import { demostdlib } from "../utils"

import { RPCResponse } from "../network/server_rpc"

const term = terminalkit.terminal

export default class ComLinkUtils {
    // INFO common comlink digestor
    static async parseComlink(
        request: ComLink,
    ): Promise<ComLink> {
        // We need to check if the message request is valid (is a ComLink object)
        term.yellow("[COMLINKUTILS] Received comlink\n")
        // GIving the request the comlink methods
        let _comlink_request = new ComLink()
        _comlink_request.chain = request.chain
        _comlink_request.muid = request.muid
        _comlink_request.properties = request.properties
        //console.log(_comlink_request)
        // REVIEW Refusing to process requests which currentMessage size is over a defined amount
        let reqSize = sizeOf(_comlink_request)
        if (reqSize > sharedState.getInstance().maxMessageSize) {
            term.red(
                "[COMLINK MESSAGE SIZE ERROR] Request size is over the limit: " +
                    reqSize.toString() +
                    " bytes\n",
            )
            return null
        }
        // Debug log
        //console.log("\n" + _comlink_request.chain.current.currentMessage + "\n")
        // Checking validity of the comlink for non nodeCall transactions
        // NOTE nodeCall transactions are read only and can be called by any client even without authentication
        console.log(
            "The request has a current message that is a: " +
                typeof _comlink_request.chain.current.currentMessage,
        )
        let type_of_call: string
        try {
            type_of_call =
                _comlink_request.chain.current.currentMessage.bundle.content
                    .type
        } catch (e) {
            log.error("[Comlink Validation Error 1] " + e)
            return null
        }
        if (!(type_of_call === "nodeCall")) {
            let valid: any[]
            try {
                valid = await _comlink_request.validateComlink()
            } catch (e) {
                valid = [
                    false,
                    "Exception during validateComlink" + e.toString(),
                ]
            }
            if (!valid[0]) {
                log.error("[Comlink Validation Error 2] " + valid[1])
                return null
            }
        } else {
            term.green("[COMLINK] nodeCall received (no auth required)\n")
        }

        console.log("[COMLINK PARSING] Parsing comlink message...")
        // Sanitizing the request
        if (!request.muid) {
            console.log(
                "[COMLINK PARSING] No muid specified. Erroring back.",
            )
            return null
        }
        console.log("[COMLINK PARSING] MUID: " + request.muid)
        // Taking the message part
        /*if (!(typeof request.chain.current.currentMessage === "object")) {
            content = JSON.parse(request.chain.current.currentMessage).bundle
                .content
        } else { */
        let content = request.chain.current.currentMessage.bundle.content
        //}
        if (!content) {
            console.log(
                "[COMLINK PARSING] Eww, no content specified. Erroring back.",
            )
            //console.log(request.chain.current.currentMessage.bundle)
            return null
        }
        console.log("[COMLINK PARSING] Content parsed")
        //console.log(content)
        if (!content.message && !content.data) {
            console.log(
                "[COMLINK PARSING] No message or data specified. Erroring back.",
                //console.log(content),
            )
            return null
        }
        console.log("[COMLINK PARSING] Message parsed")
        return _comlink_request
    }

    // INFO reply to a comlink
    static async replyToComlink( // ? REVIEW RPC compliant reply
        comlink: ComLink,
        response: RPCResponse,
    ): Promise<RPCResponse> {
        await demostdlib.reply(comlink, response)
        // Now we need to return a RPCResponse
        let rpcResponse: RPCResponse = {
            result: response.result,
            response: response.response,
            require_reply: response.require_reply,
            extra: response.extra,
        }
        //LINK - receiver.emit("comlink_reply", comlink) // ? Replaced with rpc methods compliant stuff
        // TODO add logging
        return rpcResponse
    }
}
