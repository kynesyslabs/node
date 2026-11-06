import type Peer from "src/libs/peer/Peer"
import PeerManager from "src/libs/peer/PeerManager"
import GossipManager from "src/libs/gossip/GossipManager"
import { scheduleHeightProbe } from "src/libs/consensus/v2/routines/committedBlock"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

/**
 * With gossip off, a node learns that the network is ahead only from blocks
 * and sync claims peers push to it. A node that was down gets neither, so it
 * reads its stale head as synced and never catches up. Asking peers for their
 * head closes that gap; a height above ours goes to the height probe, which
 * counts it only once the peer has served quorum-verified blocks up to it, so
 * a peer that overstates its height gains nothing.
 */
export async function pollPeerHeights(
    peers: Peer[] = PeerManager.getInstance().getPeers(),
): Promise<void> {
    if (GossipManager.isEnabled()) return
    const head = getSharedState.lastBlockNumber
    await Promise.all(
        peers.map(async peer => {
            if (peer.identity === getSharedState.publicKeyHex) return
            try {
                const res = await peer.call(
                    {
                        method: "nodeCall",
                        params: [
                            {
                                message: "getLastBlockNumber",
                                data: null,
                                muid: null,
                            },
                        ],
                    },
                    false,
                )
                const height = Number(res?.response)
                if (res?.result !== 200 || !Number.isSafeInteger(height)) return
                if (height > head) scheduleHeightProbe(peer, height)
            } catch (e) {
                log.debug(
                    `[pollPeerHeights] ${peer.identity} did not answer: ${e instanceof Error ? e.message : String(e)}`,
                )
            }
        }),
    )
}
