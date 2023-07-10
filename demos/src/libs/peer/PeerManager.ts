import type Peer from "./Peer"

export default class PeerManager {
    private static instance: PeerManager
    private peerList: Peer[]

    private constructor() {
        this.peerList = []
    }

    static getInstance(): PeerManager {
        if (!this.instance) {
            this.instance = new PeerManager()
        }
        return this.instance
    }

    getPeers(): Peer[] {
        return this.peerList
    }

    addPeer(peer: Peer) {
        this.peerList.push(peer)
    }

    removePeer(peer: Peer) {
        const index = this.peerList.indexOf(peer)
        if (index > -1) {
            this.peerList.splice(index, 1)
        }
    }

    setPeerList(peerList: Peer[]) {
        this.peerList = peerList
    }
}
