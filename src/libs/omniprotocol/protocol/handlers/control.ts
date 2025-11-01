import { OmniHandler } from "../../types/message"
import {
    decodeNodeCallRequest,
    encodeJsonResponse,
    encodePeerlistResponse,
    encodePeerlistSyncResponse,
    encodeNodeCallResponse,
    encodeStringResponse,
    PeerlistEntry,
} from "../../serialization/control"

async function loadPeerlistEntries(): Promise<{
    entries: PeerlistEntry[]
    rawPeers: any[]
    hashBuffer: Buffer
}> {
    const { default: getPeerlist } = await import(
        "src/libs/network/routines/nodecalls/getPeerlist"
    )
    const { default: Hashing } = await import("src/libs/crypto/hashing")

    const peers = await getPeerlist()

    const entries: PeerlistEntry[] = peers.map(peer => ({
        identity: peer.identity,
        url: peer.connection?.string ?? "",
        syncStatus: peer.sync?.status ?? false,
        blockNumber: BigInt(peer.sync?.block ?? 0),
        blockHash: peer.sync?.block_hash ?? "",
        metadata: {
            verification: peer.verification,
            status: peer.status,
        },
    }))

    const hashHex = Hashing.sha256(JSON.stringify(peers))
    const hashBuffer = Buffer.from(hashHex, "hex")

    return { entries, rawPeers: peers, hashBuffer }
}

export const handleGetPeerlist: OmniHandler = async () => {
    const { entries } = await loadPeerlistEntries()

    return encodePeerlistResponse({
        status: 200,
        peers: entries,
    })
}

export const handlePeerlistSync: OmniHandler = async () => {
    const { entries, hashBuffer } = await loadPeerlistEntries()

    return encodePeerlistSyncResponse({
        status: 200,
        peerCount: entries.length,
        peerHash: hashBuffer,
        peers: entries,
    })
}

export const handleNodeCall: OmniHandler = async ({ message }) => {
    if (!message.payload || message.payload.length === 0) {
    return encodeNodeCallResponse({
        status: 400,
        value: null,
        requireReply: false,
        extra: null,
    })
    }

    const request = decodeNodeCallRequest(message.payload)
    const { default: manageNodeCall } = await import("src/libs/network/manageNodeCall")

    const params = request.params
    const data = params.length === 0 ? {} : params.length === 1 ? params[0] : params

    const response = await manageNodeCall({
        message: request.method,
        data,
        muid: "",
    })

    return encodeNodeCallResponse({
        status: response.result,
        value: response.response,
        requireReply: response.require_reply ?? false,
        extra: response.extra ?? null,
    })
}

export const handleGetPeerInfo: OmniHandler = async () => {
    const { getSharedState } = await import("src/utilities/sharedState")
    const connection = await getSharedState.getConnectionString()

    return encodeStringResponse(200, connection ?? "")
}

export const handleGetNodeVersion: OmniHandler = async () => {
    const { getSharedState } = await import("src/utilities/sharedState")
    return encodeStringResponse(200, getSharedState.version ?? "")
}

export const handleGetNodeStatus: OmniHandler = async () => {
    const { getSharedState } = await import("src/utilities/sharedState")
    const info = await getSharedState.getInfo()
    return encodeJsonResponse(200, info)
}
