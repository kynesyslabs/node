/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import sharedState from "src/utilities/sharedState"
import sizeOf from "src/utilities/sizeOf"
import { json } from "stream/consumers"
import terminalkit from "terminal-kit"

import ComLink from "./comlink"

const term = terminalkit.terminal

export default class ComLinkUtils {
    // INFO common comlink digestor
    static async parseComlink(
        request,
        peerSocket,
    ): Promise<[ComLink, any] | boolean> {
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
            peerSocket.emit("comlink", {
                status: "error",
                message: "TOO_BIG",
            })
        }
        // Debug log
        //console.log("\n" + _comlink_request.chain.current.currentMessage + "\n")
        // Checking validity of the comlink for non nodeCall transactions
        // NOTE nodeCall transactions are read only and can be called by any client even without authentication
        console.log(
            "The request has a current message that is a: " +
                typeof _comlink_request.chain.current.currentMessage,
        )
        let type_of_call
        try {
            type_of_call =
                _comlink_request.chain.current.currentMessage.bundle.content
                    .type
        } catch (e) {
            term.red("[COMLINK VALIDATION ERROR 1] " + e + "\n")
            peerSocket.emit("comlink", {
                status: "error",
                message: e,
            })
            return false
        }
        if (!(type_of_call === "nodeCall")) {
            let valid: any[]
            try {
                valid = await _comlink_request.validateComlink()
            } catch (e) {
                valid = [false, e.toString()]
            }
            if (!valid[0]) {
                term.red("[COMLINK VALIDATION ERROR 2] " + valid[1] + "\n")
                peerSocket.emit("comlink", {
                    status: "error",
                    message: valid[1],
                })
                return false
            }
        } else {
            term.green("[COMLINK] nodeCall received (no auth required)\n")
        }

        console.log("[COMLINK PARSING] Parsing comlink message...")
        // Sanitizing the request
        if (!request.muid) {
            peerSocket.emit("error", {
                muid: null,
                message: "No muid specified",
            })
            return false
        }
        console.log("[COMLINK PARSING] MUID: " + request.muid)
        // Taking the message part
        let content
        if (!(typeof request.chain.current.currentMessage === "object")) {
            content = JSON.parse(request.chain.current.currentMessage).bundle
                .content
        } else {
            content = request.chain.current.currentMessage.bundle.content
        }
        if (!content) {
            console.log(
                "[COMLINK PARSING] Eww, no content specified. Erroring back.",
            )
            //console.log(request.chain.current.currentMessage.bundle)
            peerSocket.emit("error", {
                muid: request.muid,
                message: "Ewwwwwwwww no content specified",
            })
        }
        console.log("[COMLINK PARSING] Content parsed")
        //console.log(content)
        if (!content.message) {
            console.log(
                "[COMLINK PARSING] No message specified. Erroring back.",
                //console.log(content),
            )
            peerSocket.emit("error", {
                muid: request.muid,
                message: "Eww...no message specified",
            })
            return false
        }
        console.log("[COMLINK PARSING] Message parsed")
        return [_comlink_request, content]
    }
}
