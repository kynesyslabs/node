import _ from "lodash"
import log from "src/utilities/logger"
import { SyncData } from "../peer/Peer"
import { Waiter } from "@/utilities/waiter"
import { PeerManager, Peer } from "../peer"
import { emptyResponse } from "./server_rpc"
import { getSharedState } from "src/utilities/sharedState"
import {
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { RPCResponse, SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import TxValidatorPool from "../blockchain/validation/txValidatorPool"
import { helloResponseMessage } from "../peer/helloAuth"
import GossipManager from "../gossip/GossipManager"

export interface HelloPeerRequest {
    url: string
    publicKey: string
    signature: {
        type: SigningAlgorithm
        data: string
    }
    syncData: SyncData
    nonce?: string
}

/**
 * Proof that the node answering this hello holds our key and serves the
 * URL we advertise. Bound to the caller's nonce so it cannot be replayed.
 */
async function signHelloResponse(nonce: string) {
    const url = getSharedState.exposedUrl
    const signed = await TxValidatorPool.getInstance().sign(
        getSharedState.signingAlgorithm,
        helloResponseMessage(nonce, url),
    )
    return {
        identity: getSharedState.publicKeyHex,
        url,
        signature: {
            type: getSharedState.signingAlgorithm,
            data: uint8ArrayToHex(signed.signature),
        },
    }
}

// Hello Peer takes the request of an already authenticated client and treat the client as a peer
// ! More robust checks should be done in the hello peer routine to avod adding invalid peers that may block the network
export async function manageHelloPeer(
    content: HelloPeerRequest,
    sender: string,
): Promise<RPCResponse> {
    // Prepare the response
    const response: RPCResponse = _.cloneDeep(emptyResponse)

    const peerObject = new Peer()
    peerObject.identity = content.publicKey

    if (peerObject.identity === getSharedState.publicKeyHex) {
        response.result = 200
        response.response = true
        response.extra = {
            msg: "Peer is us: skipping",
        }
        return response
    }

    peerObject.connection.string = content.url

    if (sender.toLowerCase() !== content.publicKey.toLowerCase()) {
        log.error(
            `[Hello Peer Listener] Sender ${sender} does not match the announced identity ${content.publicKey}`,
        )
        response.result = 401
        response.response = false
        response.extra = {
            msg: "sender does not match the announced identity",
        }
        return response
    }

    // Check if the authentication info is valid based on the sender info from the headers
    const signatureValid = await TxValidatorPool.getInstance().verify({
        algorithm: content.signature.type,
        message: new TextEncoder().encode(content.url),
        signature: hexToUint8Array(content.signature.data as string),
        publicKey: hexToUint8Array(sender),
    })

    if (!signatureValid) {
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

    const peerManager = PeerManager.getInstance()

    if (peerManager.getPeer(peerObject.identity)) {
        // Known peer: the signed hello may update its URL and sync data
        const [isAddedToPeerlist, message] = peerManager.addPeer(
            peerObject,
            true,
        )
        if (!isAddedToPeerlist) {
            response.result = 400
            response.response = false
            response.extra = {
                msg: "Peer not added to peerlist: " + message,
            }
            return response
        }
    } else {
        // Stranger: the caller proved it holds the key, not that the URL
        // reaches it. Hello back and let the verified reply add it.
        const [acceptable, message] = peerManager.canAddPeer(peerObject)
        if (!acceptable) {
            response.result = 400
            response.response = false
            response.extra = {
                msg: "Peer not added to peerlist: " + message,
            }
            return response
        }

        if (!PeerManager.verifying.has(peerObject.identity)) {
            log.info(
                `[Hello Peer Listener] New peer ${peerObject.identity} @ ${peerObject.connection.string}: verifying with a hello back`,
            )
            void PeerManager.sayHelloToPeer(peerObject).catch(error =>
                log.warning(
                    `[Hello Peer Listener] Hello back to ${peerObject.identity} failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                ),
            )
        }
    }

    // INFO: Return a list of all our connected peers

    const gossipAddr = GossipManager.isEnabled()
        ? GossipManager.getInstance().getListenAddr()
        : null

    response.result = 200
    response.response = true
    response.extra = {
        msg: "Peer connected",
        ...(content.nonce ? await signHelloResponse(content.nonce) : {}),
        ...(gossipAddr
            ? {
                  gossip: {
                      peerId: GossipManager.getInstance().getPeerId(),
                      multiaddr: gossipAddr,
                  },
              }
            : {}),
        syncData: peerManager.ourSyncData,
        peerlist: peerManager
            .getPeers()
            .filter(
                peer =>
                    peer.identity !== getSharedState.publicKeyHex &&
                    peer.identity !== content.publicKey,
            )
            .map(peer => ({
                url: peer.connection.string,
                publicKey: peer.identity,
            })),
    }

    if (Waiter.isWaiting(Waiter.keys.STARTUP_HELLO_PEER)) {
        Waiter.resolve(Waiter.keys.STARTUP_HELLO_PEER, response)
    }

    return response
}
