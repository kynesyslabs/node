import _ from "lodash"
import log from "src/utilities/logger"
import { SyncData } from "../peer/Peer"
import { Waiter } from "@/utilities/waiter"
import { PeerManager, Peer } from "../peer"
import { emptyResponse } from "./server_rpc"
import { getSharedState } from "src/utilities/sharedState"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"
import { RPCResponse, SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import TxValidatorPool from "../blockchain/validation/txValidatorPool"

export interface HelloPeerRequest {
    url: string
    publicKey: string
    signature: {
        type: SigningAlgorithm
        data: string
    }
    syncData: SyncData
}

// Hello Peer takes the request of an already authenticated client and treat the client as a peer
// ! More robust checks should be done in the hello peer routine to avod adding invalid peers that may block the network
export async function manageHelloPeer(
    content: HelloPeerRequest,
    sender: string,
): Promise<RPCResponse> {
    // Prepare the response
    const response: RPCResponse = _.cloneDeep(emptyResponse)

    log.info("[Handle Hello Peer] Handling hello peer...")
    log.info("[Hello Peer Listener] Building peer object...")
    const peerObject = new Peer()
    peerObject.identity = content.publicKey

    if (peerObject.identity === getSharedState.publicKeyHex) {
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
    const signatureValid = await TxValidatorPool.getInstance().verify({
        algorithm: content.signature.type,
        message: new TextEncoder().encode(content.url),
        signature: hexToUint8Array(content.signature.data as string),
        publicKey: hexToUint8Array(content.publicKey),
    })

    log.only("[Hello Peer Listener] Signature valid: " + signatureValid)
    log.only("[Hello Peer Listener] Sender: " + sender)
    log.only("[Hello Peer Listener] Public key: " + content.publicKey)
    log.only("[Hello Peer Listener] Signature: " + content.signature.data)

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
    const [isAddedToPeerlist, message] = peerManager.addPeer(peerObject)
    if (!isAddedToPeerlist) {
        response.result = 400
        response.response = false
        response.extra = {
            msg: "Peer not added to peerlist: " + message,
        }
        return response
    }

    // INFO: Return a list of all our connected peers

    response.result = 200
    response.response = true
    response.extra = {
        msg: "Peer connected",
        syncData: peerManager.ourSyncData,
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

    if (Waiter.isWaiting(Waiter.keys.STARTUP_HELLO_PEER)) {
        Waiter.resolve(Waiter.keys.STARTUP_HELLO_PEER, response)
    }

    return response
}
