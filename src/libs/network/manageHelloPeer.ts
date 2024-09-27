import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "./server_rpc"
import sharedState from "src/utilities/sharedState"
import { PeerManager, Peer } from "../peer"
import log from "src/utilities/logger"
import _ from "lodash"
import * as forge from "node-forge"
import { Cryptography } from "node_modules/@kynesyslabs/demosdk/build/encryption"

export interface HelloPeerRequest {
    url: string
    publicKey: string
    signature: string
}

// Hello Peer takes the request of an already authenticated client and treat the client as a peer
// ! More robust checks should be done in the hello peer routine to avod adding invalid peers that may block the network
export async function manageHelloPeer(
    content: HelloPeerRequest,
    sender: string,
): Promise<RPCResponse> {
    // Prepare the response
    let response: RPCResponse = _.cloneDeep(emptyResponse)

    console.log("[Handle Hello Peer] Handling hello peer...")

    // Refusing to add ourselves
    /*if (
        content.publicKey ===
        sharedState.getInstance().identity.ed25519.publicKey.toString("hex")
    ) {
        console.log(
            "[Hello Peer Listener] Refusing to add ourselves, proceeding anyway",
        )
        response.result = 200
        response.extra = "Cannot a: ", JSON.stringify(peerObject, null, 2)dd ourselves: not blocking anyway"
        return response
    } */
    log.info("[Hello Peer Listener] Building peer object...")
    let peerObject = new Peer()
    peerObject.identity = content.publicKey
    if (peerObject.identity == sharedState.getInstance().identity.ed25519.publicKey.toString("hex")) {
        console.log("[Hello Peer Listener] Peer is us: skipping")
        response.result = 200
        response.response = true
        response.extra = "Peer is us: skipping"
        return response
    }
    peerObject.connection.string = content.url
    console.log(
        "[Hello Peer Listener] Extracted peer with connection string: " +
            peerObject.connection.string,
    )

    // Check if the authentication info is valid based on the sender info from the headers
    console.log("[Hello Peer Listener] Verifying authentication info...")
    let isValid = sender === content.publicKey

    if (!isValid) {
        log.error(
            "[Hello Peer Listener] Invalid authentication info for: " +
                peerObject.identity +
                " @ " +
                peerObject.connection.string,
        )
        response.result = 401
        response.response = false
        response.extra = "invalid authentication info"
        return response
    } 

    // Add the peer as authenticated
    peerObject.verification.status = true

    // ! TODO Add info checking
    peerObject.status.ready = true
    peerObject.status.online = true
    peerObject.status.timestamp = Date.now()

    // If we are here, the peer is connected
    response.result = 200
    response.response = true
    response.extra = "Peer connected"

    console.log(
        "[Hello Peer Listener] Adding peer with id: " + peerObject.identity,
    )
    let isAddedToPeerlist = PeerManager.getInstance().addPeer(peerObject)
    if (!isAddedToPeerlist) {
        response.result = 400
        response.response = false
        response.extra = "Error while adding peer to peerlist"
        return response
    }
    return response
}
