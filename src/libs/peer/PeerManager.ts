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
import { HelloPeerRequest, PeerCapabilities } from "../network/manageHelloPeer"
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

    // REVIEW: Phase 9 - Enhanced peer list format with capabilities
    // Old format: { "pubkey": "http://url" }
    // New format: { "pubkey": { url: "http://url", capabilities?: {...} } }
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
            peerList[getSharedState.publicKeyHex] = {
                url: getSharedState.connectionString,
            }
        }

        // Creating a peer object for each peer in the peer list
        for (const peer in peerList) {
            const peerObject = this.createNewPeer(peer)
            const peerData = peerList[peer]

            // Support both old format (string) and new format (object)
            if (typeof peerData === "string") {
                // Old format: just URL
                peerObject.connection.string = peerData
            } else {
                // New format: { url, capabilities? }
                peerObject.connection.string = peerData.url
                if (peerData.capabilities) {
                    peerObject.capabilities = peerData.capabilities
                }
            }
            this.addPeer(peerObject)
        }
    }

    // REVIEW: Phase 9 - Save peer list with capabilities
    savePeerList() {
        const peerListData: Record<string, { url: string; capabilities?: PeerCapabilities }> = {}

        for (const identity in this.peerList) {
            const peer = this.peerList[identity]
            peerListData[identity] = {
                url: peer.connection.string,
            }
            if (peer.capabilities) {
                peerListData[identity].capabilities = peer.capabilities
            }
        }

        try {
            fs.writeFileSync(
                getSharedState.peerListFile,
                JSON.stringify(peerListData, null, 2),
                "utf8",
            )
            log.info(`[PEERMANAGER] Saved peer list with ${Object.keys(peerListData).length} peers`)
        } catch (error) {
            log.error("[PEERMANAGER] Error saving peer list: " + error)
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
        log.debug(`[PEER] Getting all peers... peers=${peers}, connections=${connections}`)

        const actorList: Peer[] = []
        const connectedList: Peer[] = []
        const authenticatedList: Peer[] = []

        for (const peer in this.peerList) {
            log.debug(`[PEER] Getting peer ${peer}`)
            const peerInstance = this.peerList[peer]
            log.debug(`[PEER] With url: ${peerInstance.connection.string}`)
            // Filtering
            if (peerInstance.identity != undefined) {
                log.debug("[PEER] This peer has an identity: treating it as an authenticated peer")
                authenticatedList.push(peerInstance)
            } else {
                log.debug("[PEER] This peer has no identity: treating it as a connection only peer")
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

        log.debug(`[PEER] Retrieved and filtered actor list length: ${actorList.length}`)
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
        log.custom(
            "peer_list",
            JSON.stringify(jsonPeerList),
            false,
            true,
        )
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
            log.info(
                "[PEERMANAGER] Peer: " + JSON.stringify(peer),
                false,
            )
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

            // REVIEW: Phase 9 - Update capabilities if provided
            if (peer.capabilities) {
                existingPeer.capabilities = peer.capabilities
                log.debug("[PEERMANAGER] Updated peer capabilities")
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
    static async sayHelloToPeer(peer: Peer) {
        getSharedState.peerRoutineRunning += 1 // Adding one to the peer routine running counter

        // TODO test and finalize this method
        log.info(`[DEBUG HELLO PEER] Starting hello_peer handshake with peer ${peer.identity.slice(0, 16)}...`, false)
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

        // REVIEW: Phase 9 - Include IPFS capabilities for swarm discovery
        // Pass peer URL to filter addresses based on local/remote network
        const capabilities = await PeerManager.getOurCapabilities(peer.connection.string)
        log.info(`[DEBUG CAPABILITIES] Our capabilities to send: ${JSON.stringify(capabilities)}`, false)

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
            capabilities,
        }

        log.debug(
            "[Hello Peer] Hello request: " +
                JSON.stringify(helloRequest),
        )
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
        return PeerManager.helloPeerCallback(response, peer)

        // then(response => {
        //     PeerManager.helloPeerCallback(response, peer)
        // })
        log.debug("[Hello Peer] Hello request sent: waiting for response")
    }

    // Callback for the hello peer
    static async helloPeerCallback(response: RPCResponse, peer: Peer) {
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
                "[Hello Peer] Received sync data: " + JSON.stringify(response.extra.syncData),
                false,
            )

            if (response.extra.syncData) {
                peer.sync = response.extra.syncData
            }

            // REVIEW: Phase 9 - Extract capabilities from response
            log.info("[DEBUG HELLO PEER] Raw response.extra: " + JSON.stringify(response.extra), false)
            // DEBUG: Write to file for full inspection
            await log.custom("hello_peer_debug", `CLIENT RECEIVED response.extra: ${JSON.stringify(response.extra, null, 2)}`, false)
            if (response.extra.capabilities) {
                peer.capabilities = response.extra.capabilities
                log.info(
                    "[DEBUG CAPABILITIES] Received capabilities from peer: " + JSON.stringify(response.extra.capabilities),
                    false,
                )
            } else {
                log.info("[DEBUG CAPABILITIES] No capabilities in response from peer", false)
            }

            log.debug(
                "[DEBUG HELLO PEER] Final Peer sync data: " +
                    JSON.stringify(peer.sync),
            )
            log.debug(
                "[DEBUG CAPABILITIES] Final Peer capabilities: " +
                    JSON.stringify(peer.capabilities),
            )

            PeerManager.getInstance().addPeer(peer)
            PeerManager.getInstance().removeOfflinePeer(peer.identity)

            // REVIEW: Phase 9 - Save peer list after updating capabilities
            PeerManager.getInstance().savePeerList()
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

    async sayHelloToAllPeers() {
        const allPeers = this.getPeers()

        await Promise.all(
            allPeers.map(peer => PeerManager.sayHelloToPeer(peer)),
        )
    }

    // REVIEW: Phase 9 - IPFS capabilities for peer discovery
    /**
     * Get our node's capabilities to advertise to peers
     * Currently includes IPFS info for swarm discovery
     *
     * DEBUG: Errors are fatal for debugging purposes
     */

    /**
     * REVIEW: Phase 9 - Check if a URL/hostname is on a local network
     * Used to determine whether to include local IPFS addresses in capabilities
     */
    static isLocalNetwork(urlOrHost: string): boolean {
        try {
            // Extract hostname from URL or use as-is if it's already a hostname
            let hostname: string
            try {
                const parsed = new URL(urlOrHost)
                hostname = parsed.hostname
            } catch {
                // Not a URL, treat as hostname/IP directly
                hostname = urlOrHost
            }

            // Check for localhost patterns
            if (hostname === "localhost" ||
                hostname === "127.0.0.1" ||
                hostname === "::1" ||
                hostname.endsWith(".local") ||
                hostname.endsWith(".localhost")) {
                return true
            }

            // Check for private IP ranges (RFC 1918)
            // 10.0.0.0/8
            if (hostname.startsWith("10.")) {
                return true
            }

            // 192.168.0.0/16
            if (hostname.startsWith("192.168.")) {
                return true
            }

            // 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
            if (hostname.startsWith("172.")) {
                const secondOctet = parseInt(hostname.split(".")[1], 10)
                if (secondOctet >= 16 && secondOctet <= 31) {
                    return true
                }
            }

            // REVIEW: Phase 9 - Check if peer's public IP matches our own public IP
            // This handles the case where two nodes behind the same NAT both advertise
            // their public IP - they're on the same local network
            try {
                const ourExposedUrl = getSharedState.exposedUrl
                if (ourExposedUrl) {
                    const ourHostname = new URL(ourExposedUrl).hostname
                    if (hostname === ourHostname) {
                        log.info(`[isLocalNetwork] Peer ${hostname} matches our public IP - treating as local network`)
                        return true
                    }
                }
            } catch {
                // Ignore errors in checking our own URL
            }

            return false
        } catch (err) {
            log.warning(`[isLocalNetwork] Failed to parse URL: ${urlOrHost}, assuming remote`)
            return false
        }
    }

    static async getOurCapabilities(peerUrl?: string): Promise<PeerCapabilities | undefined> {
        // Lazy import to avoid circular dependencies and startup issues
        const { ensureIpfsManager } = await import(
            "@/libs/network/routines/nodecalls/ipfs/ipfsManager"
        )

        const ipfs = await ensureIpfsManager()
        const nodeInfo = await ipfs.getNodeInfo()

        if (!nodeInfo.peerId || nodeInfo.addresses.length === 0) {
            log.error("[IPFS] Cannot build capabilities - IPFS not ready")
            return undefined
        }

        // REVIEW: Phase 9 - Determine if peer is on local network
        const isLocalPeer = peerUrl ? PeerManager.isLocalNetwork(peerUrl) : false

        // REVIEW: Phase 9 - Filter IPFS addresses for hello_peer capability exchange
        // Always filter out: localhost, 0.0.0.0, and all IPv6 addresses
        // For local peers: keep LAN + public addresses
        // For remote peers: only keep public addresses
        const filteredAddresses = nodeInfo.addresses.filter(addr => {
            // Always exclude localhost addresses (never useful for peer-to-peer)
            if (addr.includes("/127.") || addr.includes("/0.0.0.0/") || addr.includes("/localhost/")) {
                return false
            }

            // Always exclude IPv6 addresses (we don't use them)
            if (addr.includes("/ip6/") || addr.includes("/::1/") || addr.includes("/::/")) {
                return false
            }

            // Check if this is a private/LAN address
            const isLanAddr = addr.includes("/192.168.") ||
                              addr.includes("/10.") ||
                              addr.includes("/172.16.") ||
                              addr.includes("/172.17.") ||
                              addr.includes("/172.18.") ||
                              addr.includes("/172.19.") ||
                              addr.includes("/172.20.") ||
                              addr.includes("/172.21.") ||
                              addr.includes("/172.22.") ||
                              addr.includes("/172.23.") ||
                              addr.includes("/172.24.") ||
                              addr.includes("/172.25.") ||
                              addr.includes("/172.26.") ||
                              addr.includes("/172.27.") ||
                              addr.includes("/172.28.") ||
                              addr.includes("/172.29.") ||
                              addr.includes("/172.30.") ||
                              addr.includes("/172.31.")

            if (isLocalPeer) {
                // For local peers, include both LAN and public addresses
                return true
            } else {
                // For remote peers, only include public addresses (exclude LAN)
                return !isLanAddr
            }
        })

        if (filteredAddresses.length === 0) {
            log.warn("[IPFS] No addresses to advertise after filtering")
            return undefined
        }

        log.debug(`[IPFS] Capabilities: ${filteredAddresses.length} addresses (local peer: ${isLocalPeer})`)

        return {
            ipfs: {
                peerId: nodeInfo.peerId,
                addresses: filteredAddresses,
            },
        }
    }
}
