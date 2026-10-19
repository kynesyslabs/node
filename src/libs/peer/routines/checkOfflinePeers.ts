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

    // Online peers that went silent get one ping; a failure moves them to
    // the offline table so the hello above recovers them later.
    const quietPeers = peerman.getQuietPeers()
    const probePromises = quietPeers.map(async quietPeer => {
        const alive = await quietPeer.connect()
        if (!alive) {
            log.warning(
                `[PEER RECHECK] ${quietPeer.identity} @ ${quietPeer.connection.string} silent for ${Math.round((now - (quietPeer.status.timestamp ?? 0)) / 1000)}s and not answering: marking offline`,
            )
            PeerManager.markPeerOffline(quietPeer)
        }
    })

    await Promise.all([...checkPromises, ...probePromises])
    getSharedState.inPeerRecheckLoop = false
    log.info(
        `[PEER RECHECK] Finished checking ${Object.keys(offlinePeers).length} offline and ${quietPeers.length} quiet peers`,
    )
}
