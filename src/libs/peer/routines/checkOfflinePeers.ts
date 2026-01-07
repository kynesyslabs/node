import log from "src/utilities/logger"
import PeerManager from "../PeerManager"
import { getSharedState } from "src/utilities/sharedState"

// REVIEW Check offline peers asynchronously
export default async function checkOfflinePeers(): Promise<void> {
    // INFO add a reentrancy check
    if (getSharedState.inPeerRecheckLoop) {
        return
    }

    getSharedState.inPeerRecheckLoop = true
    const now = Date.now()

    if (
        now - getSharedState.lastPeerRecheck <
        getSharedState.peerRecheckSleepTime
    ) {
        getSharedState.inPeerRecheckLoop = false
        return
    }

    log.info("[PEER RECHECK] Checking offline peers")
    getSharedState.lastPeerRecheck = now
    const peerman = PeerManager.getInstance()

    const offlinePeers = peerman.getOfflinePeers()
    const checkPromises = Object.values(offlinePeers).map(async offlinePeer => {
        await PeerManager.sayHelloToPeer(offlinePeer)
    })

    await Promise.all(checkPromises)
    getSharedState.inPeerRecheckLoop = false
    log.info("[PEER RECHECK] Finished checking offline peers")
}
