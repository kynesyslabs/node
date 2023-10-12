/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Peer from "./Peer"

export default class PeerManager {
    private static instance: PeerManager
    private peerList: Record<string, Peer>
    // TODO Use a mapping too to link a connection string to a peer?

    private constructor() {
        this.peerList = {}
    }

    static getInstance(): PeerManager {
        if (!this.instance) {
            this.instance = new PeerManager()
        }
        return this.instance
    }

    createNewPeer(identity: string): Peer {
        const peer = new Peer()
        peer.identity = identity
        return peer
    }

    getPeers(): Peer[] {
        const peerList: Peer[] = []
        for (const peer in this.peerList) {
            let _peer = this.peerList[peer]
            if (_peer.identity != undefined) {
                peerList.push(this.peerList[peer])
            } else {
                console.log(
                    "[PEERMANAGER] This peer has no identity: treating it as a read only peer",
                )
            }
        }
        console.log("[PEERMANAGER] Peerlist length: " + peerList.length)
        return peerList
    }

    getPeer(identity: string): Peer {
        return this.peerList[identity]
    }

    async getOnlinePeers(): Promise<Peer[]> {
        const onlinePeers: Peer[] = []
        for await (const _peer of Object.values(this.peerList)) {
            const peerInstance = new Peer()
            peerInstance.identity = _peer.identity
            const onlinePeerStatus = await peerInstance.checkOnlineStatus()
            if (onlinePeerStatus.status === "online") {
                onlinePeers.push(peerInstance)
            }
        }
        return onlinePeers
    }

    addPeer(peer: Peer) {
        console.log("[PEERMANAGER] Adding peer")
        if (peer.identity === "placeholder") {
            console.log("[WARN] No identity detected: refusing to add peer")
            console.log(peer)
            return false
        }
        const identity = peer.identity.toString("hex")
        this.peerList[identity] = peer
        console.log("[PEERMANAGER] Peer added")
        console.log("Identity: " + peer.identity.toString("hex"))
        console.log("Connection string: " + peer.connectionString)
        if (!peer.connectionString) {
            console.log("[WARN] No connection string detected")
        }
        // FIXME Run the routine in peers to get it
        return true
    }

    removePeer(peer: Peer) {
        if (this.peerList[peer.identity.toString("hex")]) {
            delete this.peerList[peer.identity.toString("hex")]
        }
    }
}
