/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Peer from "./Peer"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { HelloPeerRequest } from "../network/manageHelloPeer"
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import fs from "fs"

export default class PeerManager {
    private static instance: PeerManager
    private peerList: Record<string, Peer> // Storing all the connections, will be filtered once the request is done
    private offlinePeers: Record<string, Peer> // Storing all the offline peers to be retried later

    private constructor() {
        this.peerList = {}
        this.offlinePeers = {}
    }

    get ourSyncData() {
        const peer = this.peerList[getSharedState.publicKeyHex]
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
        let rawPeerList = "{}"

        try {
            rawPeerList = fs.readFileSync(getSharedState.peerListFile, "utf8")
        } catch (error) {
            // INFO: Skip no file error
            if (!(error instanceof Error && error.message.includes("ENOENT"))) {
                // INFO: Crash for debugging purposes
                log.error("[PEER] Error loading peer list: " + error)
                process.exit(1)
            }
        }

        const peerList = JSON.parse(rawPeerList)

        // INFO: If this peer is not in peer list, add it
        if (!peerList[getSharedState.publicKeyHex]) {
            peerList[getSharedState.publicKeyHex] =
                getSharedState.connectionString
        }

        // Creating a peer object for each peer in the peer list, assigning the connection string and adding it to the peer list
        for (const peer in peerList) {
            const peerObject = this.createNewPeer(peer)
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
        return this.getActors(true, false)
    }

    getPeer(identity: string): Peer {
        const peer = this.peerList[identity]

        log.debug("[PeerManager] Peer: " + JSON.stringify(peer))

        return peer
    }

    getAll(): Peer[] {
        return this.getActors(true, true)
    }

    getOfflinePeers(): Record<string, Peer> {
        return this.offlinePeers
    }

    private getActors(peers: boolean, connections: boolean): Peer[] {
        log.debug(
            `[PEER] Getting all peers... peers=${peers}, connections=${connections}`,
        )

        const actorList: Peer[] = []
        const connectedList: Peer[] = []
        const authenticatedList: Peer[] = []

        for (const peer in this.peerList) {
            log.debug(`[PEER] Getting peer ${peer}`)
            const peerInstance = this.peerList[peer]
            log.debug(`[PEER] With url: ${peerInstance.connection.string}`)
            // Filtering
            if (peerInstance.identity != undefined) {
                log.debug(
                    "[PEER] This peer has an identity: treating it as an authenticated peer",
                )
                authenticatedList.push(peerInstance)
            } else {
                log.debug(
                    "[PEER] This peer has no identity: treating it as a connection only peer",
                )
                connectedList.push(peerInstance)
            }
        }

        // Merging and returning
        if (peers) {
            actorList.push(...authenticatedList)
        }

        if (connections) {
            actorList.push(...connectedList)
        }

        log.debug(
            `[PEER] Retrieved and filtered actor list length: ${actorList.length}`,
        )
        return actorList
    }

    // Creating a JSON object with the peerlist and logging it
    logPeerList() {
        const jsonPeerList = {}
        for (const peer in this.peerList) {
            jsonPeerList[peer] = {
                connectionString: this.peerList[peer].connection.string,
                identity: this.peerList[peer].identity,
                isAuthenticated: this.peerList[peer].verification.status,
            }
        }
        // Flushing the log file and logging the peerlist
        log.custom("peer_list", JSON.stringify(jsonPeerList), false, true)
    }

    async getOnlinePeers(): Promise<Peer[]> {
        //const onlinePeers: Peer[] = []
        for await (const peerInstance of Object.values(this.peerList)) {
            log.info(
                "[PEERMANAGER] Checking online status of peer " +
                    peerInstance.identity,
                false,
            )
            if (peerInstance.identity == getSharedState.publicKeyHex) {
                log.info("[PEERMANAGER] Peer is us: skipping", false)
                continue
            }
            await PeerManager.sayHelloToPeer(peerInstance)
        }
        // Returning the list of online peers from the peerlist
        return this.getPeers() // REVIEW is this working?
    }

    addPeer(peer: Peer) {
        log.info("[PEERMANAGER] Adding peer: " + JSON.stringify(peer))
        log.info("[PEERMANAGER] Adding peer: " + peer.identity)
        log.info("[PEERMANAGER] Adding peer", false)
        if (peer.identity === "placeholder") {
            log.warning(
                "[PEERMANAGER] No identity detected: refusing to add peer",
                true,
            )
            log.info("[PEERMANAGER] Peer: " + JSON.stringify(peer), false)
            return false
        }

        // REVIEW check for duplicates
        const identity = peer.identity
        let action = "added"
        const existingPeer = this.peerList[identity]

        if (existingPeer) {
            log.debug("[PEER] Peer already exists: updating it")
            action = "updated"

            const { block, status } = existingPeer.sync
            const { timestamp, ready, online } = existingPeer.status

            // INFO: When overwriting an existing peer, info update properties
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
                log.debug(
                    "[PEERMANAGER] Existing connection string: " +
                        existingPeer.connection.string,
                )
                log.debug(
                    "[PEERMANAGER] New connection string: " +
                        peer.connection.string,
                )
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
        const identity = getSharedState.publicKeyHex
        const peer = this.peerList[identity]

        if (!peer) {
            log.error("[PEERMANAGER] Peer not found: " + identity)
            return
        }

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

    setPeers(peerlist: Peer[], discardCurrentPeerlist = true) {
        if (discardCurrentPeerlist) {
            this.peerList = {}
        }
        for (const peer of peerlist) {
            this.addPeer(peer)
        }
    }

    // REVIEW This method should be tested and finalized with the new peer structure
    static async sayHelloToPeer(peer: Peer, recursive = false) {
        getSharedState.peerRoutineRunning += 1 // Adding one to the peer routine running counter

        // TODO test and finalize this method
        log.debug("[Hello Peer] Saying hello to peer " + peer.identity)
        const connectionString = getSharedState.exposedUrl // ? Are we sure about this
        const signedConnectionString = await ucrypto.sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(connectionString),
        )

        log.debug("[Hello Peer] Signing connection string: " + connectionString)
        log.debug(
            "[Hello Peer] Signed connection string: " +
                uint8ArrayToHex(signedConnectionString.signature),
        )

        // Sending the transmission to the peer
        const helloRequest: HelloPeerRequest = {
            url: connectionString,
            publicKey: getSharedState.publicKeyHex,
            signature: {
                type: getSharedState.signingAlgorithm,
                data: uint8ArrayToHex(signedConnectionString.signature),
            },
            syncData: {
                block: getSharedState.lastBlockNumber,
                block_hash: getSharedState.lastBlockHash,
                status: getSharedState.syncStatus,
            },
        }

        log.debug("[Hello Peer] Hello request: " + JSON.stringify(helloRequest))
        // Not awaiting the response to not block the main thread
        const response = await peer.longCall(
            {
                method: "hello_peer",
                params: [helloRequest],
            },
            true,
            250,
            3,
        )

        log.debug("[Hello Peer] Response: " + JSON.stringify(response))

        const newPeersUnfiltered = PeerManager.helloPeerCallback(response, peer)
        if (!recursive) {
            return
        }

        // INFO: Recursively say hello to the new peers
        const peerManager = PeerManager.getInstance()
        const newPeers = newPeersUnfiltered.filter(
            ({ publicKey }) => !peerManager.getPeer(publicKey),
        )

        // say hello to the new peers
        await Promise.all(
            newPeers.map(peer =>
                PeerManager.sayHelloToPeer(new Peer(peer.url, peer.publicKey)),
            ),
        )
    }

    // Callback for the hello peer
    static helloPeerCallback(
        response: RPCResponse,
        peer: Peer,
    ): { url: string; publicKey: string }[] {
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
                    JSON.stringify(peer.sync),
            )

            PeerManager.getInstance().addPeer(peer)
            PeerManager.getInstance().removeOfflinePeer(peer.identity)

            log.debug(
                "[Hello Peer] New peers: " +
                    JSON.stringify(response.extra.peerlist, null, 2),
            )

            return response.extra.peerlist || []
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
        return []
    }
}
