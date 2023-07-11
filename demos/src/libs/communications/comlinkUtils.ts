import ComLink from "./comlink"
import { Bundle } from './types/transmit';

export default class ComLinkUtils {
    // INFO common comlink digestor
    static async parseComlink(
        request,
        peerSocket,
    ): Promise<[ComLink, any] | boolean> {
        // We need to check if the message request is valid (is a ComLink object)
        console.log("[SERVER] Received comlink")
        //console.log(request)
        // GIving the request the comlink methods
        let _comlink_request = new ComLink()
        _comlink_request.chain = request.chain
        _comlink_request.muid = request.muid
        _comlink_request.properties = request.properties
        // Checking validity of the comlink
        let valid = await _comlink_request.validateComlink()
        if (!valid[0]) {
            console.log("[COMLINK VALIDATION ERROR] " + valid[1])
            peerSocket.emit("comlink", {
                status: "error",
                message: valid[1],
            })
            return false
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
            content = JSON.parse(request.chain.current.currentMessage).bundle.content
        } else {
            content = request.chain.current.currentMessage.bundle.content
        }
        if (!content.message) {
            console.log(
                "[COMLINK PARSING] No message specified. Erroring back.",
                console.log(content)
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
