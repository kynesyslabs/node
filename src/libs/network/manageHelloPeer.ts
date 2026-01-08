import _ from "lodash"
import log from "src/utilities/logger"
import { SyncData } from "../peer/Peer"
import { Waiter } from "@/utilities/waiter"
import { PeerManager, Peer } from "../peer"
import { emptyResponse } from "./server_rpc"
import { getSharedState } from "src/utilities/sharedState"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { RPCResponse, SigningAlgorithm } from "@kynesyslabs/demosdk/types"

// REVIEW: Phase 9 - IPFS peer discovery via hello_peer
/**
 * IPFS capabilities exchanged during peer discovery
 * Enables dynamic IPFS swarm formation through Demos peer network
 */
export interface IpfsCapabilities {
    /** IPFS peer ID (base58 encoded) */
    peerId: string
    /** IPFS multiaddrs for direct connection (e.g., /ip4/x.x.x.x/tcp/4001/p2p/QmXXX) */
    addresses: string[]
}

/**
 * Optional capabilities advertised by peers
 * Extensible for future features (e.g., relay, storage, compute)
 */
export interface PeerCapabilities {
    /** IPFS node info for swarm discovery */
    ipfs?: IpfsCapabilities
}

export interface HelloPeerRequest {
    url: string
    publicKey: string
    signature: {
        type: SigningAlgorithm
        data: string
    }
    syncData: SyncData
    /** Optional capabilities - for backward compatibility with older nodes */
    capabilities?: PeerCapabilities
}

// Hello Peer takes the request of an already authenticated client and treat the client as a peer
// ! More robust checks should be done in the hello peer routine to avod adding invalid peers that may block the network
export async function manageHelloPeer(
    content: HelloPeerRequest,
    sender: string,
): Promise<RPCResponse> {
    // Prepare the response
    const response: RPCResponse = _.cloneDeep(emptyResponse)

    log.info(`[DEBUG HELLO PEER] Received hello_peer from sender ${sender.slice(0, 16)}...`, false)
    log.info("[Handle Hello Peer] Handling hello peer...")
    log.info("[Hello Peer Listener] Building peer object...")
    const peerObject = new Peer()
    peerObject.identity = content.publicKey

    // REVIEW: Self-peer detection - can be bypassed via env var for debugging
    const DEBUG_SKIP_SELF_CHECK = process.env.DEBUG_SKIP_SELF_CHECK === "true"
    if (!DEBUG_SKIP_SELF_CHECK && peerObject.identity == getSharedState.publicKeyHex) {
        log.debug("[Hello Peer Listener] Peer is us: skipping")
        response.result = 200
        response.response = true
        response.extra = {
            msg: "Peer is us: skipping",
        }
        return response
    }

    peerObject.connection.string = content.url
    log.info(
        "[Hello Peer Listener] Extracted peer with connection string: " +
            peerObject.connection.string,
    )

    // Check if the authentication info is valid based on the sender info from the headers
    log.info("[Hello Peer Listener] Verifying authentication info...")
    const signatureValid = await ucrypto.verify({
        algorithm: content.signature.type,
        message: new TextEncoder().encode(content.url),
        signature: hexToUint8Array(content.signature.data as string),
        publicKey: hexToUint8Array(content.publicKey),
    })

    const isValid = sender === content.publicKey && signatureValid

    if (!isValid) {
        log.error(
            "[Hello Peer Listener] Invalid authentication info for: " +
                peerObject.identity +
                " @ " +
                peerObject.connection.string,
        )
        response.result = 401
        response.response = false
        response.extra = {
            msg: "invalid authentication info",
        }
        return response
    }

    // Add the peer as authenticated
    peerObject.verification.status = true

    // ! TODO Add info checking
    peerObject.status.ready = true
    peerObject.status.online = true
    peerObject.status.timestamp = Date.now()

    // INFO: Write the sync data for the peer
    peerObject.sync = content.syncData

    // REVIEW: Phase 9 - Store capabilities on peer object
    if (content.capabilities) {
        peerObject.capabilities = content.capabilities
        log.info(
            "[DEBUG CAPABILITIES] Incoming peer capabilities: " +
                JSON.stringify(peerObject.capabilities),
        )
    }

    log.debug(
        "[Hello Peer Listener] Sender sync data: " +
            JSON.stringify(peerObject.sync),
    )

    const peerManager = PeerManager.getInstance()

    // If we are here, the peer is connected
    log.info(
        "[Hello Peer Listener] Adding peer with id: " + peerObject.identity,
    )
    log.info(
        "[DEBUG CAPABILITIES] Final peer capabilities stored: " + JSON.stringify(peerObject.capabilities),
    )
    const isAddedToPeerlist = peerManager.addPeer(peerObject)
    if (!isAddedToPeerlist) {
        response.result = 400
        response.response = false
        response.extra = {
            msg: "Error while adding peer to peerlist",
        }
        return response
    }

    // REVIEW: Phase 9 - Save peer list after adding peer with capabilities
    peerManager.savePeerList()

    response.result = 200
    response.response = true

    // REVIEW: Phase 9 - Get our capabilities to send back in response
    // Import lazily to avoid circular dependencies
    // Pass peer URL to filter addresses based on local/remote network
    const { PeerManager: PM } = await import("../peer")
    const ourCapabilities = await PM.getOurCapabilities(content.url)

    response.extra = {
        msg: "Peer connected",
        syncData: peerManager.ourSyncData,
        capabilities: ourCapabilities, // REVIEW: Phase 9 - Include our capabilities in response
        // INFO: Return a list of all our connected peers (from custom_protocol)
        peerlist: peerManager
            .getPeers()
            .map(peer => ({
                url: peer.connection.string,
                publicKey: peer.identity,
            }))
            .filter(
                peer =>
                    peer.publicKey !== getSharedState.publicKeyHex &&
                    peer.publicKey !== content.publicKey,
            ),
    }

    log.info(`[DEBUG CAPABILITIES] Sending response with our capabilities: ${JSON.stringify(ourCapabilities)}`)

    // REVIEW: Phase 9 - Connect IPFS peers dynamically
    // REVIEW: Non-fatal error handling - IPFS peer connection failure should not crash the node
    if (content.capabilities?.ipfs) {
        handleIpfsCapabilities(content.capabilities.ipfs, peerObject.identity).catch((err) => {
            log.error(`[Hello Peer] IPFS peer connection failed (non-fatal): ${err}`)
        })
    }

    // INFO: Resolve waiter if waiting for hello_peer (from custom_protocol)
    if (Waiter.isWaiting(Waiter.keys.STARTUP_HELLO_PEER)) {
        Waiter.resolve(Waiter.keys.STARTUP_HELLO_PEER, response)
    }

    return response
}

/**
 * Handle IPFS capabilities from a peer - connect to their IPFS node
 * This runs asynchronously and doesn't block the hello_peer response
 *
 * DEBUG: Errors are fatal for debugging purposes
 */
async function handleIpfsCapabilities(
    ipfsCapabilities: IpfsCapabilities,
    demosIdentity: string,
): Promise<void> {
    // Lazy import to avoid circular dependencies
    const { ensureIpfsManager } = await import("@/libs/network/routines/nodecalls/ipfs/ipfsManager")

    const ipfs = await ensureIpfsManager()

    // REVIEW: Phase 9 - Skip connecting to ourselves (IPFS/libp2p rejects self-dial)
    const ourNodeInfo = await ipfs.getNodeInfo()
    if (ourNodeInfo.peerId === ipfsCapabilities.peerId) {
        log.debug("[IPFS] Skipping self-connection")
        return
    }

    log.info(`[IPFS] Connecting to peer ${ipfsCapabilities.peerId.slice(0, 16)}... from ${demosIdentity.slice(0, 8)}`)

    // Try each address until one succeeds
    for (const addr of ipfsCapabilities.addresses) {
        log.debug(`[IPFS] Trying address: ${addr.slice(0, 50)}...`)
        const result = await ipfs.connectPeer(addr)
        if (result.success) {
            log.info(`[IPFS] Connected to peer ${ipfsCapabilities.peerId.slice(0, 16)}...`)
            // Register the Demos-IPFS peer mapping for future reference
            ipfs.registerDemosPeer(ipfsCapabilities.peerId, addr)
            return
        }
        log.debug(`[IPFS] Address failed: ${result.error}`)
    }

    // REVIEW: Phase 9 - Connection failures are expected for NAT/firewall peers
    log.warn(`[IPFS] Could not connect to peer ${ipfsCapabilities.peerId.slice(0, 16)}... (${ipfsCapabilities.addresses.length} addresses tried)`)
}
