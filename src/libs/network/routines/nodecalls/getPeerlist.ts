import { Peer } from "src/libs/peer"

import PeerManager from "../../../peer/PeerManager"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

export default async function getPeerlist(): Promise<Peer[]> {
    console.log("[SERVER] Executing getPeerlist")
    // Getting our current peerlist
    const socketizedResponse = PeerManager.getInstance().getPeers()
    const response = [] as Peer[]

    // Filling response with peers without socket objects
    for (const peer of socketizedResponse) {
        // peer.connection.socket = null // ? What is this
        response.push(peer)

        if (
            peer.identity === getSharedState.publicKeyHex &&
            peer.connection.string.startsWith("http://127.0.0.1")
        ) {
            log.debug("Was returning local connection string")
            log.debug(JSON.stringify(peer))
            log.debug("getSharedState.exposedUrl: " + getSharedState.exposedUrl)

            peer.connection.string = getSharedState.exposedUrl
            log.debug(JSON.stringify(peer))
            // process.exit(0)
        }
    }

    // Ordering the peerlist in an alphanumeric way
    response.sort((a, b) => a.identity.localeCompare(b.identity))
    return response
}
