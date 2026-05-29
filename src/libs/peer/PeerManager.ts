/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import fs from "fs"
import Peer from "./Peer"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { HelloPeerRequest } from "../network/manageHelloPeer"
import { ucrypto, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import TxValidatorPool from "../blockchain/validation/txValidatorPool"

export default class PeerManager {
    private static instance: PeerManager
    private peerList: Record<string, Peer> // Storing all the connections, will be filtered once the request is done
    private offlinePeers: Record<string, Peer> // Storing all the offline peers to be retried later

    private constructor() {
        this.peerList = {}
        this.offlinePeers = {}
    }

    get ourPeer() {
        return this.peerList[getSharedState.publicKeyHex]
    }

    get ourSyncData() {
        return this.ourPeer.sync
    }

    get ourSyncDataString() {
        const { status, block, block_hash: blockHash } = this.ourPeer.sync
        return `${status ? "1" : "0"}:${block}:${blockHash}`
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
                log.error("[PEER] Error loading peer list: " + error)
                this.peerList = {}
                return
            }
        }

        let peerList: Record<string, unknown>
        try {
            peerList = JSON.parse(rawPeerList)
        } catch (error) {
            log.warning("[PEER] Corrupt peer list file, treating as empty: " + error)
            peerList = {}
        }

        // INFO: If this peer is not in peer list, add it
        if (!peerList[getSharedState.publicKeyHex]) {
            peerList[getSharedState.publicKeyHex] =
                getSharedState.connectionString
        }

        // Creating a peer object for each peer in the peer list, assigning the connection string and adding it to the peer list
        for (const peer in peerList) {
            const peerObject = this.createNewPeer(peer)
            // REVIEW: Handle both old format (string) and new format (object with url property)
            const peerData = peerList[peer]
            if (typeof peerData === "string") {
                // Old format: { "pubkey": "http://..." }
                peerObject.connection.string = peerData
            } else if (
                typeof peerData === "object" &&
                peerData !== null &&
                "url" in peerData
            ) {
                // New format: { "pubkey": { "url": "http://...", "capabilities": {...} } }
                // REVIEW: Validate that url is a non-empty string before assignment
                const url = peerData.url
                if (typeof url !== "string" || url.trim().length === 0) {
                    log.warning(
                        `[PEER] Invalid or empty URL for peer ${peer}: ${JSON.stringify(peerData)}`,
                    )
                    continue
                }
                peerObject.connection.string = url
            } else {
                log.warning(
                    `[PEER] Invalid peer data format for ${peer}: ${JSON.stringify(peerData)}`,
                )
                continue
            }
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

        if (identity === getSharedState.publicKeyHex) {
            peer.status.online = true
        }

        return peer
    }

    getPeers(): Peer[] {
        return this.getActors(true, false)
    }

    getPeer(identity: string): Peer {
        return this.peerList[identity]
    }

    getAll(): Peer[] {
        return this.getActors(true, true)
    }

    getOfflinePeers(): Record<string, Peer> {
        return this.offlinePeers
    }

    private getActors(peers: boolean, connections: boolean): Peer[] {
        const actorList: Peer[] = []
        const connectedList: Peer[] = []
        const authenticatedList: Peer[] = []

        for (const peer in this.peerList) {
            const peerInstance = this.peerList[peer]
            // Filtering
            if (peerInstance.identity != undefined) {
                authenticatedList.push(peerInstance)
            } else {
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
        await Promise.all(
            Object.values(this.peerList).map(async peerInstance => {
                if (peerInstance.identity == getSharedState.publicKeyHex) {
                    return
                }

                await PeerManager.sayHelloToPeer(peerInstance)
            }),
        )

        // Returning the list of online peers from the peerlist
        return this.getPeers() // REVIEW is this working?
    }

    addPeer(peer: Peer): [boolean, string] {
        if (peer.identity === "placeholder") {
            log.warning(
                "[PEERMANAGER] No identity detected: refusing to add peer",
                true,
            )
            log.info(
                "[PEERMANAGER] Peer: " + JSON.stringify(peer, null, 2),
                false,
            )
            return [false, "No identity detected!"]
        }

        let parsedHostname: string
        try {
            parsedHostname = new URL(peer.connection.string).hostname
        } catch (_e) {
            log.warning("[PEERMANAGER] Invalid connection string URL, rejecting peer: " + peer.connection.string)
            return [false, "Invalid connection string: " + peer.connection.string]
        }

        if (
            getSharedState.PROD &&
            peer.identity !== getSharedState.publicKeyHex &&
            ["127.0.0.1", "localhost", "0.0.0.0"].includes(parsedHostname)
        ) {
            log.warning(
                "[PEERMANAGER] Invalid connection string: " +
                    peer.connection.string,
            )
            log.error("[PEERMANAGER] Peer not added: " + peer.identity)
            return [
                false,
                "Invalid connection string: " + peer.connection.string,
            ]
        }

        // REVIEW check for duplicates
        const identity = peer.identity
        let action = "added"
        const existingPeer = this.peerList[identity]

        if (existingPeer) {
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
                existingPeer.connection.string = peer.connection.string
            }
        } else {
            log.info("[PEERMANAGER] Adding new peer: " + peer.identity, true)
            this.peerList[identity] = peer
        }

        return [true, ""]
    }

    /**
     * Updates the sync data for our peer in the peerlist
     */
    updateOurPeerSyncData() {
        const identity = getSharedState.publicKeyHex
        const peer = this.peerList[identity]

        if (!peer) {
            return
        }

        peer.sync.status = getSharedState.syncStatus
        peer.sync.block = getSharedState.lastBlockNumber
        peer.sync.block_hash = getSharedState.lastBlockHash
    }

    updatePeerLastSeen(pubkey: string) {
        if (pubkey && !pubkey.startsWith("0x")) {
            pubkey = "0x" + pubkey
        }

        let peer = this.peerList[pubkey]

        if (!peer) {
            // Check if peer is in offlinePeers — if so, move back to active list
            if (this.offlinePeers[pubkey]) {
                log.warn(
                    "[PEERMANAGER] Peer is in offlinePeers: removing from offlinePeers and adding to peer list",
                )
                this.addPeer(this.offlinePeers[pubkey])
                this.removeOfflinePeer(pubkey)
                peer = this.peerList[pubkey]
            } else {
                return
            }
        }

        peer.status.online = true
        peer.status.timestamp = Date.now()
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
        // TODO test and finalize this method
        const connectionString = getSharedState.exposedUrl // ? Are we sure about this
        const signedConnectionString = await TxValidatorPool.getInstance().sign(
            getSharedState.signingAlgorithm,
            new TextEncoder().encode(connectionString),
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

        // Not awaiting the response to not block the main thread
        const response = await peer.longCall(
            {
                method: "hello_peer",
                params: [helloRequest],
            },
            true,
            {
                sleepTime: 250,
                retries: 1,
                allowedCodes: [500, 504],
            },
        )

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
        //console.log(response) // ? Delete this if not needed
        // TODO Test and Finish this
        // REVIEW is the message the response itself?
        // Based on the response, we can decide what to do
        if (response.result === 200) {
            if (response.extra.syncData) {
                peer.sync = response.extra.syncData
            }

            PeerManager.getInstance().addPeer(peer)
            PeerManager.getInstance().removeOfflinePeer(peer.identity)

            return response.extra.peerlist || []
        } else {
            PeerManager.markPeerOffline(peer)
        }

        // getSharedState.peerRoutineRunning -= 1 // Subtracting one from the peer routine running counter
        //process.exit(0)
        return []
    }

    static markPeerOffline(peer: Peer) {
        // INFO: Local peer should always be accessible
        if (peer.identity === getSharedState.publicKeyHex) {
            return
        }

        peer.status.online = false
        peer.status.timestamp = Date.now()

        const peerman = PeerManager.getInstance()
        peerman.addOfflinePeer(peer)
        peerman.removeOnlinePeer(peer.identity)
    }
}
