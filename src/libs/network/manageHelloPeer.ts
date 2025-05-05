import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "./server_rpc"
import { getSharedState } from "src/utilities/sharedState"
import { PeerManager, Peer } from "../peer"
import log from "src/utilities/logger"
import _ from "lodash"
import * as forge from "node-forge"
import Cryptography from "../crypto/cryptography"
import { SyncData } from "../peer/Peer"

export interface HelloPeerRequest {
    url: string
    publicKey: string
    signature: string
    syncData: SyncData
}

// Hello Peer takes the request of an already authenticated client and treat the client as a peer
// ! More robust checks should be done in the hello peer routine to avod adding invalid peers that may block the network
export async function manageHelloPeer(
    content: HelloPeerRequest,
    sender: string,
): Promise<RPCResponse> {
    log.debug("[manageHelloPeer] Content: " + JSON.stringify(content, null, 2))
    // Prepare the response
    const response: RPCResponse = _.cloneDeep(emptyResponse)

    log.info("[Handle Hello Peer] Handling hello peer...")
    log.info("[Hello Peer Listener] Building peer object...")
    const peerObject = new Peer()
    peerObject.identity = content.publicKey

    if (
        peerObject.identity ==
        getSharedState.identity.ed25519.publicKey.toString("hex")
    ) {
        console.log("[Hello Peer Listener] Peer is us: skipping")
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
    const isValid =
        sender === content.publicKey &&
        Cryptography.verify(content.url, content.signature, content.publicKey)

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
            JSON.stringify(peerObject.sync, null, 2),
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

    return response
}
