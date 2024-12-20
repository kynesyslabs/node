/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Peer, { SyncData } from "./Peer"
import log from "src/utilities/logger"
import Cryptography from "../crypto/cryptography"
import { getSharedState } from "src/utilities/sharedState"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { HelloPeerRequest } from "../network/manageHelloPeer"
import fs from "fs"

function ForgeToHex(forgeBuffer: any) {
    console.log("[forge to string encoded]")
    //console.log(forgeBuffer)
    let rebuffer = Buffer.from(forgeBuffer)
    forgeBuffer = rebuffer.toString("hex")
    console.log("DECODED INTO:")
    console.log("0x" + forgeBuffer)
    return "0x" + forgeBuffer
}

export default class PeerManager {
    private static instance: PeerManager
    private peerList: Record<string, Peer> // Storing all the connections, will be filtered once the request is done
    private offlinePeers: Record<string, Peer> // Storing all the offline peers to be retried later

    private constructor() {
        this.peerList = {}
        this.offlinePeers = {}
    }

    get ourSyncData() {
        const identity =
            getSharedState.identity.ed25519.publicKey.toString("hex")
        const peer = this.peerList[identity]
        return peer.sync
    }

    static getInstance(): PeerManager {
        if (!this.instance) {
            this.instance = new PeerManager()
        }
        return this.instance
    }

    // Loading the peer list from the demos_peer.json
    loadPeerList() {
        let rawPeerList = fs.readFileSync(getSharedState.peerListFile, "utf8")
        let peerList = JSON.parse(rawPeerList)
        // Creating a peer object for each peer in the peer list, assigning the connection string and adding it to the peer list
        for (const peer in peerList) {
            let peerObject = this.createNewPeer(peer)
            peerObject.connection.string = peerList[peer]
            this.addPeer(peerObject)
        }
    }

    // Fetching peer info from /info endpoint
    async fetchPeerInfo(peer: Peer) {
        const info = await peer.fetch("info")
    }

    createNewPeer(identity: string): Peer {
        const peer = new Peer()
        peer.identity = identity
        peer.connection.string = ""
        return peer
    }

    getPeers(): Peer[] {
        return this._getActors(true, false)
    }

    getPeer(identity: string): Peer {
        const peer = this.peerList[identity]

        log.debug("[PeerManager] Peer: " + JSON.stringify(peer, null, 2))

        return peer
    }

    getAll(): Peer[] {
        return this._getActors(true, true)
    }

    getOfflinePeers(): Record<string, Peer> {
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
            console.log("[PeerManager] With url: " + _peer.connection.string)
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

    // Creating a JSON object with the peerlist and logging it
    logPeerList() {
        const json_peerlist = {}
        for (const peer in this.peerList) {
            json_peerlist[peer] = {
                connection_string: this.peerList[peer].connection.string,
                identity: this.peerList[peer].identity,
                is_authenticated: this.peerList[peer].verification.status,
            }
        }
        // Flushing the log file and logging the peerlist
        log.custom(
            "peer_list",
            JSON.stringify(json_peerlist, null, 2),
            false,
            true,
        )
    }

    async getOnlinePeers(): Promise<Peer[]> {
        //const onlinePeers: Peer[] = []
        for await (const _peer of Object.values(this.peerList)) {
            const peerInstance = new Peer()
            peerInstance.identity = _peer.identity
            peerInstance.connection.string = _peer.connection.string
            log.info(
                "[PEERMANAGER] Checking online status of peer " +
                    peerInstance.identity,
                false,
            )
            if (
                peerInstance.identity ==
                getSharedState.identity.ed25519.publicKey.toString("hex")
            ) {
                log.info("[PEERMANAGER] Peer is us: skipping", false)
                continue
            }
            await PeerManager.sayHelloToPeer(peerInstance)
        }
        // Returning the list of online peers from the peerlist
        return this.getPeers() // REVIEW is this working?
    }

    addPeer(peer: Peer) {
        log.info("[PEERMANAGER] Adding peer", false)
        if (peer.identity === "placeholder") {
            log.warning(
                "[PEERMANAGER] No identity detected: refusing to add peer",
                true,
            )
            log.info(
                "[PEERMANAGER] Peer: " + JSON.stringify(peer, null, 2),
                false,
            )
            return false
        }

        // REVIEW check for duplicates
        const identity = peer.identity
        let action = "added"
        const existingPeer = this.peerList[identity]

        if (existingPeer) {
            console.log("[PEERMANAGER] Peer already exists: updating it")
            action = "updated"

            const { block, status } = existingPeer.sync
            const { timestamp, ready, online } = existingPeer.status

            // INFO: When overwriting an existing peer, only update properties
            // if the new peer has data && data is more recent
            if (
                peer.sync.block > block ||
                (peer.sync.block == block && peer.sync.status !== status)
            ) {
                existingPeer.sync.block = peer.sync.block
                existingPeer.sync.block_hash = peer.sync.block_hash
                existingPeer.sync.status = peer.sync.status
            }

            if (peer.status.timestamp > timestamp) {
                existingPeer.status.timestamp = peer.status.timestamp
                existingPeer.status.ready = peer.status.ready
                existingPeer.status.online = peer.status.online
            }

            if (peer.connection.string !== existingPeer.connection.string) {
                log.debug("[PEERMANAGER] Updating connection string")
                log.debug("[PEERMANAGER] Existing connection string: " + existingPeer.connection.string)
                log.debug("[PEERMANAGER] New connection string: " + peer.connection.string)
                existingPeer.connection.string = peer.connection.string

            }
        } else {
            log.info("[PEERMANAGER] Adding new peer: " + peer.identity, true)
            this.peerList[identity] = peer
        }

        log.info("[PEERMANAGER] Peer " + action, false)
        log.info("[PEERMANAGER] Identity: " + peer.identity, false)
        log.info(
            "[PEERMANAGER] Connection string: " + peer.connection.string,
            false,
        )
        if (!peer.connection.string) {
            log.warning("[PEERMANAGER] No connection string detected", true)
        }
        return true
    }

    /**
     * Updates the sync data for our peer in the peerlist
     */
    updateOurPeerSyncData() {
        const identity =
            getSharedState.identity.ed25519.publicKey.toString("hex")
        const peer = this.peerList[identity]

        peer.sync.status = getSharedState.syncStatus
        peer.sync.block = getSharedState.lastBlockNumber
        peer.sync.block_hash = getSharedState.lastBlockHash
    }

    addOfflinePeer(peerInstance: Peer) {
        log.info(
            "[PEERMANAGER] Adding offline peer " +
                peerInstance.connection.string,
            false,
        )
        // REVIEW: Why did we have an if here?
        // if (this.offlinePeers[peerInstance.identity]) {
        //     this.offlinePeers[peerInstance.identity] = peerInstance
        // }
        this.offlinePeers[peerInstance.identity] = peerInstance
        log.info("[PEERMANAGER] Offline peers: " + this.offlinePeers, false)
    }

    removeOnlinePeer(identity: string) {
        delete this.peerList[identity]
    }

    removeOfflinePeer(identity: string) {
        delete this.offlinePeers[identity]
    }

    setPeers(peerlist: Peer[], discard_current_peerlist: boolean = true) {
        if (discard_current_peerlist) {
            this.peerList = {}
        }
        for (const peer of peerlist) {
            this.addPeer(peer)
        }
    }

    // REVIEW This method should be tested and finalized with the new peer structure
    static async sayHelloToPeer(peer: Peer) {
        getSharedState.peerRoutineRunning += 1 // Adding one to the peer routine running counter

        // TODO test and finalize this method
        log.info("[Hello Peer] Saying hello to peer " + peer.identity, false)
        const our_id = getSharedState.identity.ed25519.publicKey
        let connection_string = getSharedState.exposedUrl // ? Are we sure about this
        let signed_connection_string = Cryptography.sign(
            connection_string,
            getSharedState.identity.ed25519.privateKey,
        )

        log.info(
            "[Hello Peer] Signing connection string: " + connection_string,
            false,
        )
        log.info(
            "[Hello Peer] Signed connection string: " +
                ForgeToHex(signed_connection_string),
            false,
        )

        // Sending the transmission to the peer
        const hello_request: HelloPeerRequest = {
            url: connection_string,
            publicKey: our_id.toString("hex"),
            signature: signed_connection_string.toString("hex"),
            syncData: {
                block: getSharedState.lastBlockNumber,
                block_hash: getSharedState.lastBlockHash,
                status: getSharedState.syncStatus,
            },
        }
        // Not awaiting the response to not block the main thread
        peer.longCall(
            {
                method: "hello_peer",
                params: [hello_request],
            },
            true,
            250,
            3,
        ).then(response => {
            PeerManager.helloPeerCallback(response, peer)
        })
        log.info("[Hello Peer] Hello request sent: waiting for response", false)
    }

    // Callback for the hello peer
    static helloPeerCallback(response: RPCResponse, peer: Peer) {
        log.info(
            "[Hello Peer] Response received from peer: " + peer.identity,
            false,
        )
        //console.log(response) // ? Delete this if not needed
        // TODO Test and Finish this
        // REVIEW is the message the response itself?
        log.info("[Hello Peer] Response message: " + response.response, false)
        // Based on the response, we can decide what to do
        if (response.result === 200) {
            log.info(
                "[Hello Peer] Peer is online, replied and recognized us. Adding to peer list",
                false,
            )
            log.info(
                "[Hello Peer] Received message: " + response.extra.msg,
                false,
            )
            log.info(
                "[Hello Peer] Received sync data: " + response.extra.syncData,
                false,
            )

            if (response.extra.syncData) {
                peer.sync = response.extra.syncData
            }

            log.debug(
                "[Hello Peer] Final Peer sync data: " +
                    JSON.stringify(peer.sync, null, 2),
            )

            PeerManager.getInstance().addPeer(peer)
            PeerManager.getInstance().removeOfflinePeer(peer.identity)
        } else {
            log.info(
                "[Hello Peer] Failed to connect to peer: " +
                    peer.identity +
                    ". Adding to offline list",
                false,
            )
            // Add the peer to the offline list
            PeerManager.getInstance().addOfflinePeer(peer)
            PeerManager.getInstance().removeOnlinePeer(peer.identity)
        }
        getSharedState.peerRoutineRunning -= 1 // Subtracting one from the peer routine running counter
        //process.exit(0)
    }
}
