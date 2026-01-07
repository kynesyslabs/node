/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { cryptography } from "src/libs/crypto"

import Peer from "../Peer"
import PeerManager from "../PeerManager"
import getPeerIdentity from "./getPeerIdentity"
import log from "src/utilities/logger"

const peerManager = PeerManager.getInstance()

// Proxy function to call peerBootstrap in a nicer way
export async function peerlistCheck(localList: Peer[]): Promise<Peer[]> {
    return await peerBootstrap(localList)
}

// ANCHOR Main function

export default async function peerBootstrap(
    localList: Peer[],
): Promise<Peer[]> {
    log.info("[PEER] ===== BOOTSTRAP ENTRY: " + localList.length + " peers =====")
    log.info("[DEBUG HELLO PEER] peerBootstrap called with " + localList.length + " peers")
    log.info("[BOOTSTRAP] Loading peers...")
    // Validity check
    for (let i = 0; i < localList.length; i++) {
        log.debug("[BOOTSTRAP] Checking peer " + localList[i])
        // ANCHOR Extract peer info from the string
        const currentPeer: Peer = localList[i] // The url of the peer
        // If there is a : in the url, we assume it's a address + port
        const currentPeerUrl: string = currentPeer.connection.string
        const currentPublicKey: string = currentPeer.identity
        log.debug("[BOOTSTRAP] Testing " + currentPeerUrl + " with id " + currentPublicKey)
        // ANCHOR Connection test and hello_peer routine
        const blankPeer = new Peer(currentPeerUrl, currentPublicKey)
            // Adding identity if any
        log.debug("[BOOTSTRAP] Testing " + currentPeerUrl + " identity")
        // After this, the peer object will have an identity and thus will be verified
        const verifiedPeer = await getPeerIdentity(
            blankPeer,
            currentPublicKey,
        )
        if (!verifiedPeer) {
            log.warning("[BOOTSTRAP] [FAILED] Failed to get peer identity: see above")
            peerManager.addOfflinePeer(blankPeer)
            peerManager.removeOnlinePeer(blankPeer.identity)
            continue
        }

        log.debug("[BOOTSTRAP] Overriding connection string: " + currentPeerUrl)
        log.debug("[BOOTSTRAP] Verified peer: " + JSON.stringify(verifiedPeer))
        // ! remove debug code
        try {
            verifiedPeer.connection.string = currentPeerUrl // Adding this step
        } catch (error) {
            log.error("[BOOTSTRAP] Error setting connection string: " + error)
            log.critical("Error setting connection string: " + error)
            continue
        }
        log.info("[BOOTSTRAP] OK: Valid peer " + currentPeerUrl)

        log.debug("[BOOTSTRAP] Current peer object: " + JSON.stringify(verifiedPeer))
        // This should automatically add the peer to the peer list or the offline list
        // let response = await verifiedPeer.longCall({
        //     method: "hello_peer",
        //     params: [{
        //         url: verifiedPeer.connection.string,
        //         publicKey: currentPublicKey,
        //     }],
        // }, true, 250, 3)
        log.info("[DEBUG HELLO PEER] About to call sayHelloToPeer for " + verifiedPeer.identity.slice(0, 16) + "...")
        await PeerManager.sayHelloToPeer(verifiedPeer)
        // console.log("[BOOTSTRAP] Response: " + JSON.stringify(response, null, 2))
    }
    // Dying if there are no valid peers
    if (peerManager.getPeers().length == 0) {
        // Exit if there are no valid peers
        log.warning("[BOOTSTRAP] No valid peers found, listening for connections...")
    } else {
        log.info("[BOOTSTRAP] Valid peers found: " + peerManager.getPeers().length)
    }
    return peerManager.getPeers()
}
