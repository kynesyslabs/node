/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Peer from "./Peer"
import log from "src/utilities/logger"


export default class PeerManager {
    private static instance: PeerManager
    private peerList: Record<string, Peer> // Storing all the connections, will be filtered once the request is done
    private offlinePeers: string[] // Storing all the offline peers to be retried later

    private constructor() {
        this.peerList = {}
        this.offlinePeers = []
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
        return this._getActors(true, false)
    }

    // INFO Getting all peers that have no identity (aka clients, dapps and so on)
    getConnections(): Peer[] {
        return this._getActors(false, true)
    }

    getAll(): Peer[] {
        return this._getActors(true, true)
    }


    getOfflinePeers(): string[] {
        return this.offlinePeers
    }


    private _getActors(peers: boolean, connections: boolean): Peer[] {
        console.log("[PeerManager] Getting all peers...")
        console.log("[PeerManager] peers: " + peers)
        console.log("[PeerManager] connections: " + connections)
        const actorList: Peer[] = []
        const connectedList: Peer[] = []
        const authenticatedList: Peer[] = []
        //console.log(this.peerList)
        for (const peer in this.peerList) {
            console.log("[PeerManager] Getting peer " + peer)
            let _peer = this.peerList[peer]
            // Filtering
            if (_peer.identity != undefined) {
                console.log(
                    "[PEERMANAGER] This peer has an identity: treating it as an authenticated peer",
                )
                authenticatedList.push(_peer)
            } else {
                console.log(
                    "[PEERMANAGER] This peer has no identity: treating it as a connection only peer",
                )
                connectedList.push(_peer)
            }
        }
        // Merging and returning
        if (peers) {
            actorList.push(...authenticatedList)
        }
        if (connections) {
            actorList.push(...connectedList)
        }
        console.log(
            "[PEERMANAGER] Retrieved and filtered actor list length: " +
                actorList.length,
        )
        return actorList
    }


    getPeer(identity: string): Peer {
        return this.peerList[identity]
    }

    async getOnlinePeers(): Promise<Peer[]> {
        const onlinePeers: Peer[] = []
        for await (const _peer of Object.values(this.peerList)) {
            const peerInstance = new Peer()
            peerInstance.identity = _peer.identity
            peerInstance.connectionString = _peer.connectionString
            peerInstance.socket = _peer.socket
            const onlinePeerStatus = await peerInstance.checkOnlineStatus()
            if (onlinePeerStatus) {
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
        // ! TODO check for duplicates
        const identity = peer.identity.toString("hex")
        this.peerList[identity] = peer
        console.log("[PEERMANAGER] Peer added")
        console.log("Identity: " + peer.identity.toString("hex"))
        console.log("Connection string: " + peer.connectionString)
        if (!peer.connectionString) {
            console.log("[WARN] No connection string detected")
        }
        // FIXME Run the routine in peers to get it
        // REVIEW Sync?
        return true
    }

    removePeer(peer: Peer) {
        if (this.peerList[peer.identity.toString("hex")]) {
            delete this.peerList[peer.identity.toString("hex")]
        }
    }

    addOfflinePeer(peerString: string) {
        if (this.offlinePeers.indexOf(peerString) === -1) {
            this.offlinePeers.push(peerString)
        }
    }

    removeOfflinePeer(peerString: string) {
        this.offlinePeers = this.offlinePeers.filter((peer) => peer !== peerString)
    }

    // REVIEW this should replace much of the client.ts and peerBootstrap.ts logic
    // for creating a Peer from a string, thus making it easier to work with a peer
    static extractPeerFromString(peerString: string): Peer {
        // If there is a : in the url, we assume it's a address + port
        let currentPeerAddress: string
        let currentPeerPort: number
        let currentPublicKey: string
        if (peerString.includes(">")) {
            currentPeerAddress = peerString.split(">")[0]
            currentPeerPort = parseInt(peerString.split(">")[1])
            currentPublicKey = peerString.split(">")[2]
        } else {
            currentPeerAddress = peerString
            currentPeerPort = 53550
        }
        const peer = new Peer()
        peer.identity = Buffer.from(currentPublicKey, "hex")
        peer.connectionString = currentPeerAddress + ">" + currentPeerPort
        // NOTE peer.socket = null
        return peer
    }

}
