import sharedState from "src/utilities/sharedState"

import ComLink from "../../communications/comlink"
import ResponseRegistry from "../../communications/responseRegistry"
import Transmission from "../../communications/transmission"
import { Peer } from "../../peer"

// INFO Compose, sign and send a signed comlink chain easily
export async function remoteCall(
    receiver: any, // While is preferable to have an hex string we can use anything here
    peer: Peer,
    message: string,
    type: string = "nodeCall",
    requireReply: boolean = false,
    isReply: boolean = false,
    args: any = null,
): Promise<[boolean, any]> {
    let { identity } = sharedState.getInstance()
    console.log("[remoteCall] Type: " + type)
    console.log("[remoteCall] Message: " + message)
    console.log("[remoteCall] Receiver: " + receiver)
    console.log("[remoteCall] Args: " + args)
    // Initialize the comlink
    let _comlink = new ComLink()
    // Generate the transmission
    let _askMessage = new Transmission(identity.ed25519.privateKey)
    _askMessage.initialize(
        type,
        message,
        identity.ed25519.publicKey,
        receiver,
        args,
        null,
    )
    // Hash and sign it
    console.log("[SYNC] Finalizing the message by hashing and signing")
    await _askMessage.finalize()
    console.log("[SYNC] Finalized the message")
    // Putting the message into a new comlink
    console.log("[SYNC] Putting the message into the comlink using socket: ")
    console.log(peer.socket)
    console.log(
        "[SYNC] Asking " + peer.socket.id + " for " + type + "\n" + message,
    )
    // Preparing for a response
    _comlink.properties.require_reply = requireReply
    _comlink.properties.is_reply = isReply

    // Propagating the responseRegistry actual status
    ResponseRegistry.getInstance().requestResponse(_comlink)
    console.log("[RESPONSE REQUESTED]")
    // Ask for the last block
    await _comlink.broadcastMessageToPeer(
        peer,
        _askMessage,
        identity.ed25519.privateKey,
    )

    // Get out the response promise
    let responsePromise = ResponseRegistry.getInstance().checkResponse(
        _comlink.muid,
    )
    return responsePromise
}
