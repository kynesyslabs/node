/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import type Peer from "./Peer"

export default class PeerManager {
    private static instance: PeerManager
    private peerList: Record<string, Peer>

    private constructor() {
        this.peerList = {}
    }

    static getInstance(): PeerManager {
        if (!this.instance) {
            this.instance = new PeerManager()
        }
        return this.instance
    }

    getPeers(): Peer[] {
        const peerList: Peer[] = []
        for (const peer in this.peerList) {
            peerList.push(this.peerList[peer])
        }
        console.warn("[PEERMANAGER] Peerlist length: " + peerList.length)
        return peerList
    }

    getPeer(identity: string): Peer {
        return this.peerList[identity]
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
        console.log("Identity: "  + peer.identity.toString("hex"))
        console.log("Connection string: " + peer.connectionString)
        if (!peer.connectionString) console.log("[WARN] No connection string detected")
        // FIXME Run the routine in peers to get it
        return true
    }

    removePeer(peer: Peer) {
        if (this.peerList[peer.identity.toString("hex")]) {
            delete this.peerList[peer.identity.toString("hex")]
        }
    }
}
