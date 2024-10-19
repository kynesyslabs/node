import { Peer } from "src/libs/peer"

import PeerManager from "../../../peer/PeerManager"

export default async function getPeerlist(): Promise<Peer[]> {
    console.log("[SERVER] Executing getPeerlist")
    // Getting our current peerlist
    let socketized_response = PeerManager.getInstance().getPeers()
    let response = [] as Peer[]
    // Filling response with peers without socket objects
    for (let peer of socketized_response) {
        // peer.connection.socket = null // ? What is this
        response.push(peer)
    }
    // Ordering the peerlist in an alphanumeric way
    response.sort((a, b) => a.identity.localeCompare(b.identity))
    return response
}
