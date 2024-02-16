/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// TODO Do the same but with connectionString

import Peer from "../Peer"
import ComLink from "../../communications/comlink"
import Transmission from "../../communications/transmission"
import ResponseRegistry from "../../communications/responseRegistry"
import { Socket } from "socket.io"

export default async function getPeerConnectionString(
    peer: Peer,
    id: any,
): Promise<Peer> {
    // A peer object must have a valid socket
    if (!peer.socket) {
        return null
    }
    // Asking the peer for its identity
    let comlink = new ComLink()
    let identity_ask = new Transmission(id.privateKey)
    identity_ask.initialize(
        "nodeCall",
        "getPeerConnectionString",
        id.publicKey,
        "placeholder",
        null,
        null,
    )
    await identity_ask.finalize()
    comlink.properties.require_reply = true
    comlink.properties.is_reply = false
    // Adding the response request
    ResponseRegistry.getInstance().requestResponse(comlink)
    // Broadcasting the request
    await comlink.broadcastMessageToPeer(peer, identity_ask, id.privateKey)
    // Awaiting the response
    let response = await ResponseRegistry.getInstance().checkResponse(
        comlink.muid,
    )
    // Response management
    if (response[0]) {
        console.log("[PEER CONNECTION] Received response")
        //console.log(response[1])
        peer.connectionString = response[1].message
    } else {
        console.log("[PEER CONNECTION] No response received")
    }
    return peer
}
