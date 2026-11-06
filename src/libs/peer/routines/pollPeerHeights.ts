import type Peer from "src/libs/peer/Peer"
import PeerManager from "src/libs/peer/PeerManager"
import GossipManager from "src/libs/gossip/GossipManager"
import { scheduleHeightProbe } from "src/libs/consensus/v2/routines/committedBlock"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"

/**
 * How long one peer may take to report its head. A peer that does not answer
 * would otherwise hold the round for the transport's own timeout (30 s on
 * OmniProtocol), delaying the next poll for every other peer.
 */
export const HEIGHT_POLL_TIMEOUT_MS = 3_000

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
    timeoutMs = HEIGHT_POLL_TIMEOUT_MS,
): Promise<void> {
    if (GossipManager.isEnabled()) return
    const head = getSharedState.lastBlockNumber
    await Promise.all(
        peers.map(async peer => {
            if (peer.identity === getSharedState.publicKeyHex) return
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
                const res = await Promise.race([
                    peer.call(
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
                    ),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error(`no answer in ${timeoutMs}ms`)),
                            timeoutMs,
                        )
                    }),
                ])
                const height = Number(res?.response)
                if (res?.result !== 200 || !Number.isSafeInteger(height)) return
                if (height > head) scheduleHeightProbe(peer, height)
            } catch (e) {
                log.debug(
                    `[pollPeerHeights] ${peer.identity} did not answer: ${e instanceof Error ? e.message : String(e)}`,
                )
            } finally {
                clearTimeout(timer)
            }
        }),
    )
}
