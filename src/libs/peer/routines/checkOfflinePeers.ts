import PeerManager from "../PeerManager"
import sharedState from "src/utilities/sharedState"
import log from "src/utilities/logger"

// REVIEW Check offline peers asynchronously
export default async function checkOfflinePeers(): Promise<void> {
    // INFO add a reentrancy check
    if (sharedState.getInstance().inPeerRecheckLoop) {
        console.log("[MAIN LOOP] [PEER RECHECK] Reentrancy detected: we are already checking offline peers")
        return
    }
    sharedState.getInstance().inPeerRecheckLoop = true
    const offlinePeers = PeerManager.getInstance().getOfflinePeers()
    for (let i = 0; i < offlinePeers.length; i++) {
        const offlinePeerString = offlinePeers[i]
        console.log("[MAIN LOOP] [PEER RECHECK] Checking offline peer: ", offlinePeerString)
        const offlinePeer = PeerManager.extractPeerFromString(offlinePeerString)
        // TODO Add sanity checks
        const isOnline = await offlinePeer.connect()
        if (isOnline) {
            console.log("[MAIN LOOP] [PEER RECHECK] Peer is online: ", offlinePeerString)
            // Add the peer to the peer manager and online list
            PeerManager.getInstance().addPeer(offlinePeer)
            // Remove the peer from the offline list
            PeerManager.getInstance().removeOfflinePeer(offlinePeerString)
        } else {
            console.log("[MAIN LOOP] [PEER RECHECK] Peer is still offline: ", offlinePeerString)
        }
    }
    sharedState.getInstance().inPeerRecheckLoop = false
}
