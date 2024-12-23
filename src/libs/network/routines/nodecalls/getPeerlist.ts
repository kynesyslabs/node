import { Peer } from "src/libs/peer"

import PeerManager from "../../../peer/PeerManager"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

export default async function getPeerlist(): Promise<Peer[]> {
    console.log("[SERVER] Executing getPeerlist")
    // Getting our current peerlist
    let socketized_response = PeerManager.getInstance().getPeers()
    let response = [] as Peer[]

    // Filling response with peers without socket objects
    for (let peer of socketized_response) {
        // peer.connection.socket = null // ? What is this
        response.push(peer)

        if (
            peer.identity ===
                getSharedState.identity.ed25519.publicKey.toString("hex") &&
            peer.connection.string.startsWith("http://127.0.0.1")
        ) {
            log.debug("Was returning local connection string")
            log.debug(JSON.stringify(peer, null, 2))
            log.debug("getSharedState.exposedUrl: " + getSharedState.exposedUrl)

            peer.connection.string = getSharedState.exposedUrl
            log.debug(JSON.stringify(peer, null, 2))
            // process.exit(0)
        }
    }

    // Ordering the peerlist in an alphanumeric way
    response.sort((a, b) => a.identity.localeCompare(b.identity))
    return response
}
