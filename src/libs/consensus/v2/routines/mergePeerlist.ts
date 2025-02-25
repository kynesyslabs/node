import { Peer } from "src/libs/peer"
import { PeerManager } from "src/libs/peer"
// REVIEW Compile a list of peers from each shard peerlist
// REVIEW Use this in PoRBFT.ts just as mergeMempool and include it in the block creation process
// REVIEW To do this we have to edit the block structure to include a list of peers
// REVIEW Add calls to an endpoint called "peerlist" in consensus (server_rpc.ts)
// REVIEW Add an handler in endpointHandlers.ts
// TODO Test this locally
export default async function mergePeerlist(shard: Peer[]): Promise<Peer[]> {
    const ourPeerList = PeerManager.getInstance().getPeers()
    let mergedPeerList: Peer[] = []
    const promises = []
    for (const peer of shard) {
        promises.push(
            peer.call({
                method: "peerlist",
                params: [{ data: ourPeerList }],
            }),
        )
    }
    // Wait for all the calls to complete
    await Promise.all(promises)
    // Now we should have a merged peerlist
    mergedPeerList = PeerManager.getInstance().getPeers()
    // Ordering the peerlist alphanumerically
    mergedPeerList.sort((a, b) => a.identity.localeCompare(b.identity))
    PeerManager.getInstance().setPeers(mergedPeerList)
    return mergedPeerList
}
