/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { NodeCall } from "src/libs/network/manageNodeCall"
import ComLink from "../../communications/comlink"
import Transmission from "../../communications/transmission"
import Peer from "../Peer"
import sharedState from "src/utilities/sharedState"

// proxy method
export async function verifyPeer(peer: Peer, expectedKey: string): Promise<Peer> {
    await getPeerIdentity(peer, expectedKey)
    return peer
}

// Peer is verified and its status is updated
export default async function getPeerIdentity(
    peer: Peer,
    expectedKey: string,
): Promise<Peer> {

    // Getting our identity
    let id = sharedState.getInstance().identity.ed25519
    
    console.warn("[PEER AUTHENTICATION] Getting peer identity")
    console.log(peer)
    console.log(id)
    console.log(expectedKey)

    let node_call: NodeCall = {
        message: "getPeerIdentity",
        data: null,
        muid: null,
    }

    /*
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
    console.log(
        "[PEER AUTHENTICATION] Sending comlink requesting authentication",
    )
    //console.log(comlink)
    // Broadcasting the request
    let response = await comlink.broadcastMessageToPeer(peer, identity_ask, id.privateKey)
    console.log("[PEER AUTHENTICATION] Response received")
    //console.log(response)
    */

    let response = await peer.call({
        method: "nodeCall",
        params: [node_call],
    })
    // Response management
    if (response.result === 200) {
        console.log("[PEER AUTHENTICATION] Received response")
        //console.log(response[1].identity.toString("hex"))
        if (response.response.toString("hex") === expectedKey) {
            console.log("[PEER AUTHENTICATION] Identity is the expected one")
        } else {
            console.log(
                "[PEER AUTHENTICATION] Identity is not the expected one",
            )
            console.log("Expected: ")
            console.log(expectedKey)
            console.log("Received: ")
            console.log(response.response.identity.toString("hex"))
            console.log("Non hex:")
            console.log(response.response.identity)
            return null
        }
        // Adding the property to the peer
        peer.identity = response.response.identity // Identity is now known
        peer.status.online = true // Peer is now online
        peer.status.ready = true // Peer is now ready
        peer.status.timestamp = new Date().getTime()
        peer.verification.status = true // We verified the peer
        peer.verification.message = "getPeerIdentity routine verified"      
        peer.verification.timestamp = new Date().getTime()
    } else {
        console.log("[PEER AUTHENTICATION] Response " + response.result + " received: " + response.response)
    }
    // ? Should we add it to the peerList here instead of in the peerBootstrap routine / hello_peer routine?
    return peer
}
