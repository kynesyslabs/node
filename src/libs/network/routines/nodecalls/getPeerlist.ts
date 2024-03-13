import PeerManager from "../../../peer/PeerManager"
import { Peer } from "src/libs/peer"

export default async function getPeerlist(): Promise<Peer[]> {
    console.log("[SERVER] Received getPeerlist")
    // Getting our current peerlist
    let socketized_response = PeerManager.getInstance().getPeers()
    let response = [] as Peer[]
    // Filling response with peers without socket objects
    for (let peer of socketized_response) {
        peer.socket = null
        response.push(peer)
    }
    return response
}
