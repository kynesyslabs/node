/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import ComLink from "./comlink"
import { Bundle } from "./types/transmit"
var term = require("terminal-kit").terminal

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
        console.log(request)
        // If it happens to be a json, we serialize it
        let string_currentMessage = request.chain.current.currentMessage
        try {
            request.chain.current.currentMessage = JSON.parse(request.chain.current.currentMessage)
        } catch (e) {
            console.log(e)
            console.log("Assuming it's not to serialize")
        }
        console.log("\n" + request.chain.current.currentMessage + "\n")
        // Checking validity of the comlink for non nodeCall transactions
        // NOTE nodeCall transactions are read only and can be called by any client even without authentication
        if (!(_comlink_request.chain.current.currentMessage.bundle.content.type === "nodeCall")) {
            
            let valid = await _comlink_request.validateComlink()
            if (!valid[0]) {
                term.red("[COMLINK VALIDATION ERROR] " + valid[1] + "\n")
                peerSocket.emit("comlink", {
                    status: "error",
                    message: valid[1],
                })
                return false
            }
        } else term.green("[COMLINK] nodeCall received (no auth required)\n")

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
        if (!content.message) {
            console.log(
                "[COMLINK PARSING] No message specified. Erroring back.",
                console.log(content),
            )
            peerSocket.emit("error", {
                muid: request.muid,
                message: "No message specified",
            })
            return false
        }
        console.log("[COMLINK PARSING] Message parsed")
        return [_comlink_request, content]
    }
}
