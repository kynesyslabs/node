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

export const handleNodeCall: OmniHandler = async ({ message, context }) => {
    if (!message.payload || !Buffer.isBuffer(message.payload) || message.payload.length === 0) {
    return encodeNodeCallResponse({
        status: 400,
        value: null,
        requireReply: false,
        extra: null,
    })
    }

    const request = decodeNodeCallRequest(message.payload as Buffer)

    // REVIEW: Handle consensus_routine envelope format
    // Format: { method: "consensus_routine", params: [{ method: "setValidatorPhase", params: [...] }] }
    if (request.method === "consensus_routine") {
        const { default: manageConsensusRoutines } = await import(
            "src/libs/network/manageConsensusRoutines"
        )

        // Extract the inner consensus method from params[0]
        const consensusPayload = request.params[0]
        if (!consensusPayload || typeof consensusPayload !== "object") {
            return encodeNodeCallResponse({
                status: 400,
                value: "Invalid consensus_routine payload",
                requireReply: false,
                extra: null,
            })
        }

        // Call manageConsensusRoutines with sender identity and payload
        const response = await manageConsensusRoutines(
            context.peerIdentity ?? "",
            consensusPayload,
        )

        return encodeNodeCallResponse({
            status: response.result,
            value: response.response,
            requireReply: response.require_reply ?? false,
            extra: response.extra ?? null,
        })
    }

    const { manageNodeCall } = await import("src/libs/network/manageNodeCall")

    // REVIEW: The HTTP API uses "nodeCall" as method with actual RPC in params[0]
    // Format: { method: "nodeCall", params: [{ message: "getPeerlist", data: ..., muid: ... }] }
    const params = request.params
    const innerCall = params.length > 0 && typeof params[0] === "object" ? params[0] : null

    // If this is a nodeCall envelope, unwrap it
    const actualMessage = innerCall?.message ?? request.method
    const actualData = innerCall?.data ?? (params.length === 0 ? {} : params.length === 1 ? params[0] : params)
    const actualMuid = innerCall?.muid ?? ""

    const response = await manageNodeCall({
        message: actualMessage,
        data: actualData,
        muid: actualMuid,
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
