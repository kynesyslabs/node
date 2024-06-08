import PeerManager from "../PeerManager"
import Client from "src/libs/network/client"

// REVIEW Check offline peers asynchronously
export default async function checkOfflinePeers() {
    const offlinePeers = PeerManager.getInstance().getOfflinePeers()
    for (let i = 0; i < offlinePeers.length; i++) {
        const offlinePeerString = offlinePeers[i]
        const offlinePeer = PeerManager.extractPeerFromString(offlinePeerString)
        // TODO Add sanity checks
        const isOnline = await Client.connectToPeerObject(offlinePeer)
        if (isOnline[0]) {
            console.log("[MAIN LOOP] [PEER RECHECK] Peer is online: ", offlinePeerString)
            // Add the peer to the peer manager and online list
            PeerManager.getInstance().addPeer(offlinePeer)
            // Remove the peer from the offline list
            PeerManager.getInstance().removeOfflinePeer(offlinePeerString)
        } else {
            console.log("[MAIN LOOP] [PEER RECHECK] Peer is still offline: ", offlinePeerString)
        }
    }
}
