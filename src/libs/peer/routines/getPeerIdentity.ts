/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { NodeCall } from "src/libs/network/manageNodeCall"
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


    let response = await peer.call({
        method: "nodeCall",
        params: [node_call],
    })
    console.log("[PEER AUTHENTICATION] Response Received: " + JSON.stringify(response, null, 2))
    // Response management
    if (response.result === 200) {
        console.log("[PEER AUTHENTICATION] Received response")
        //console.log(response[1].identity.toString("hex"))
        console.log(response.response)
        if (response.response=== expectedKey) {
            console.log("[PEER AUTHENTICATION] Identity is the expected one")
        } else {
            console.log(
                "[PEER AUTHENTICATION] Identity is not the expected one",
            )
            console.log("Expected: ")
            console.log(expectedKey)
            console.log("Received: ")
            console.log(response.response)
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
        console.log("[PEER AUTHENTICATION] [FAILED] Response " + response.result + " received: " + response.response)
        return null
    }
    // ? Should we add it to the peerList here instead of in the peerBootstrap routine / hello_peer routine?
    return peer
}
