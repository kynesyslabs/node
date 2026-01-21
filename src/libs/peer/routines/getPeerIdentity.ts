/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { NodeCall } from "src/libs/network/manageNodeCall"
import Transmission from "../../communications/transmission"
import Peer from "../Peer"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

// proxy method
export async function verifyPeer(
    peer: Peer,
    expectedKey: string,
): Promise<Peer> {
    await getPeerIdentity(peer, expectedKey)
    return peer
}

// Peer is verified and its status is updated
export default async function getPeerIdentity(
    peer: Peer,
    expectedKey: string,
): Promise<Peer> {
    // Getting our identity
    log.debug(`[PEER AUTH] Getting peer identity for ${expectedKey}`)

    const nodeCall: NodeCall = {
        message: "getPeerIdentity",
        data: null,
        muid: null,
    }

    const response = await peer.call({
        method: "nodeCall",
        params: [nodeCall],
    })
    log.debug("[PEER AUTH] Response Received: " + JSON.stringify(response))
    // Response management
    if (response.result === 200) {
        log.debug("[PEER AUTH] Received response: " + response.response)
        if (response.response === expectedKey) {
            log.debug("[PEER AUTH] Identity is the expected one")
        } else {
            log.warning(
                `[PEER AUTH] Identity mismatch - Expected: ${expectedKey}, Received: ${response.response}`,
            )
            return null
        }
        // Adding the property to the peer
        peer.identity = response.response // Identity is now known
        peer.status.online = true // Peer is now online
        peer.status.ready = true // Peer is now ready
        peer.status.timestamp = new Date().getTime()
        peer.verification.status = true // We verified the peer
        peer.verification.message = "getPeerIdentity routine verified"
        peer.verification.timestamp = new Date().getTime()
    } else {
        log.warning(
            `[PEER AUTH] [FAILED] Response ${response.result} received: ${response.response}`,
        )
        return null
    }
    // ? Should we add it to the peerList here instead of in the peerBootstrap routine / hello_peer routine?
    return peer
}
