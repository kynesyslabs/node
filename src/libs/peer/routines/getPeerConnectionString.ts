/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// TODO Do the same but with connectionString

import { Socket } from "socket.io"

import ComLink from "../../communications/comlink"
import Transmission from "../../communications/transmission"
import Peer from "../Peer"

export default async function getPeerConnectionString(
    peer: Peer,
    id: any,
): Promise<Peer> {
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
    // Broadcasting the request
    let response = await comlink.broadcastMessageToPeer(peer, identity_ask, id.privateKey)
    // Response management
    if (response.result === 200) {
        console.log("[PEER CONNECTION] Received response")
        //console.log(response[1])
        peer.connection.string = response.response
    } else {
        console.log("[PEER CONNECTION] Response " + response.result + " received: " + response.response)
    }
    return peer
}
