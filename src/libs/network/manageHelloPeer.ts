import { RPCResponse, SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "./server_rpc"
import { getSharedState } from "src/utilities/sharedState"
import { PeerManager, Peer } from "../peer"
import log from "src/utilities/logger"
import _ from "lodash"
import { SyncData } from "../peer/Peer"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"

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
    log.debug("[manageHelloPeer] Content: " + JSON.stringify(content))
    // Prepare the response
    const response: RPCResponse = _.cloneDeep(emptyResponse)

    log.info("[Handle Hello Peer] Handling hello peer...")
    log.info("[Hello Peer Listener] Building peer object...")
    const peerObject = new Peer()
    peerObject.identity = content.publicKey

    if (peerObject.identity == getSharedState.publicKeyHex) {
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

    log.debug(
        "[Hello Peer Listener] Sender sync data: " +
            JSON.stringify(peerObject.sync),
    )

    const peerManager = PeerManager.getInstance()

    // If we are here, the peer is connected
    log.info(
        "[Hello Peer Listener] Adding peer with id: " + peerObject.identity,
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

    response.result = 200
    response.response = true
    response.extra = {
        msg: "Peer connected",
        syncData: peerManager.ourSyncData,
    }

    // REVIEW: Phase 9 - Connect IPFS peers dynamically
    // Handle IPFS capabilities if present (non-blocking, best-effort)
    if (content.capabilities?.ipfs) {
        handleIpfsCapabilities(content.capabilities.ipfs, peerObject.identity).catch((err) => {
            log.debug(`[Hello Peer] IPFS peer connection failed (non-critical): ${err}`)
        })
    }

    return response
}

/**
 * Handle IPFS capabilities from a peer - connect to their IPFS node
 * This runs asynchronously and doesn't block the hello_peer response
 */
async function handleIpfsCapabilities(
    ipfsCapabilities: IpfsCapabilities,
    demosIdentity: string,
): Promise<void> {
    // Lazy import to avoid circular dependencies
    const { ensureIpfsManager } = await import("@/libs/network/routines/nodecalls/ipfs/ipfsManager")

    try {
        const ipfs = await ensureIpfsManager()

        log.info(`[Hello Peer] Connecting to IPFS peer ${ipfsCapabilities.peerId} from Demos peer ${demosIdentity.slice(0, 16)}...`)

        // Try each address until one succeeds
        for (const addr of ipfsCapabilities.addresses) {
            const result = await ipfs.connectPeer(addr)
            if (result.success) {
                log.info(`[Hello Peer] Connected to IPFS peer ${ipfsCapabilities.peerId} via ${addr}`)
                // Register the Demos-IPFS peer mapping for future reference
                ipfs.registerDemosPeer(ipfsCapabilities.peerId, addr)
                return
            }
        }

        log.debug(`[Hello Peer] Could not connect to IPFS peer ${ipfsCapabilities.peerId} (all addresses failed)`)
    } catch (error) {
        log.debug(`[Hello Peer] IPFS connection error: ${error}`)
    }
}
