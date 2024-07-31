import { Peer } from "src/libs/peer"

import PeerManager from "../../../peer/PeerManager"

export default async function getPeerlist(): Promise<Peer[]> {
    console.log("[SERVER] Received getPeerlist")
    // Getting our current peerlist
    let socketized_response = PeerManager.getInstance().getPeers()
    let response = [] as Peer[]
    // Filling response with peers without socket objects
    for (let peer of socketized_response) {
        peer.connection.socket = null
        response.push(peer)
    }
    return response
}
