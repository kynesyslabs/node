/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Peer from "../Peer"
import ComLink from "../../communications/comlink"
import Transmission from "../../communications/transmission"
import ResponseRegistry from "../../communications/responseRegistry"

export default async function getPeerIdentity(
    peer: Peer,
    id: any,
    expectedKey: string,
): Promise<Peer> {
    // A peer object must have a valid socket
    if (!peer.socket) {
        return null
    }

    console.warn("[PEER AUTHENTICATION] Getting peer identity")
    console.log(peer)
    console.log(id)
    console.log(expectedKey)

    // Asking the peer for its identity
    let comlink = new ComLink()
    let identity_ask = new Transmission(id.privateKey)
    identity_ask.initialize(
        "nodeCall",
        "getPeerIdentity",
        id.publicKey,
        "placeholder",
        null,
        null,
    )
    console.log("[PEER AUTHENTICATION] Identity Ask")
    //console.log(identity_ask)
    await identity_ask.finalize()
    comlink.properties.require_reply = true
    comlink.properties.is_reply = false
    console.log("[PEER AUTHENTICATION] Sending comlink requesting authentication")
    //console.log(comlink)
    // Adding the response request
    ResponseRegistry.getInstance().requestResponse(comlink)
    console.log("[PEER AUTHENTICATION] Response registry is ready")
    // Broadcasting the request
    await comlink.broadcastMessageToPeer(peer, identity_ask, id.privateKey)
    // Awaiting the response
    console.log("[PEER AUTHENTICATION] Awaiting the response")
    let response = await ResponseRegistry.getInstance().checkResponse(
        comlink.muid,
    )
    console.log("[PEER AUTHENTICATION] Response received")
   //console.log(response)
    // Response management
    if (response[0]) {
        console.log("[PEER AUTHENTICATION] Received response")
       //console.log(response[1].identity.toString("hex"))
        if (response[1].identity.toString("hex") === expectedKey) {
            console.log("[PEER AUTHENTICATION] Identity is the expected one")
        } else {
            console.log(
                "[PEER AUTHENTICATION] Identity is not the expected one",
            )
            console.log("Expected: ")
            console.log(expectedKey)
            console.log("Received: ")
           //console.log(response[1].identity.toString("hex"))
            console.log("Non hex:")
           //console.log(response[1].identity)
            return null
        }
        // Adding the property to the peer
        peer.identity = response[1].identity
    } else {
        console.log("[PEER AUTHENTICATION] No response received")
    }
    return peer
}
