import { RPCResponse } from "@kynesyslabs/demosdk-http/types"
import { emptyResponse } from "./server_rpc"
import sharedState from "src/utilities/sharedState"
import { PeerManager, Peer } from "../peer"
import log from "src/utilities/logger"
import _ from "lodash"
import * as forge from "node-forge"

export interface HelloPeerRequest {
    url: string
    port: number
    publicKey: string
}

// Hello Peer takes the request of an already authenticated client and treat the client as a peer
export async function manageHelloPeer(
    content: HelloPeerRequest,
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
        response.extra = "Cannot add ourselves: not blocking anyway"
        return response
    } */
    log.info("[Hello Peer Listener] Building peer object...")
    let peerObject = new Peer()
    peerObject.identity = content.publicKey
    peerObject.connection.string = content.url + ">" + content.port + ">" + content.publicKey
    console.log("[Hello Peer Listener] Extracted peer: ", JSON.stringify(peerObject, null, 2))

    // If we are here, the peer is connected
    response.result = 200
    response.response = true
    response.extra = "Peer connected"

    // Add the peer as authenticated
    peerObject.verification.status = true
    console.log(
        "[Hello Peer Listener] Adding peer with id: " +
            peerObject.identity,
    )
    let isAddedToPeerlist = PeerManager.getInstance().addPeer(peerObject)
    if (!isAddedToPeerlist) {
        response.result = 500
        response.response = false
        response.extra = "Error while adding peer to peerlist"
        return response
    }
    return response
}
