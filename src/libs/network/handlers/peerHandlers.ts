import { RPCResponse } from "@kynesyslabs/demosdk/types"
import getPeerInfo from "../routines/nodecalls/getPeerInfo"
import getPeerlist from "../routines/nodecalls/getPeerlist"
import PeerManager from "src/libs/peer/PeerManager"
import { peerlistDigest } from "src/libs/peer/routines/peerGossip"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

export const peerHandlers: Record<string, NodeCallHandler> = {
    getPeerInfo: async (_data, response) => {
        response.response = await getPeerInfo()
        return response
    },

    getPeerlist: async (_data, response) => {
        response.response = await getPeerlist()
        return response
    },

    getPeerlistHash: async (_data, response) => {
        response.response = peerlistDigest(PeerManager.getInstance().getPeers())
        log.custom(
            "manageNodeCall",
            "Peerlist hash: " + response.response,
            true,
        )
        return response
    },

    getPeerTime: async (_data, response) => {
        response.response = new Date().getTime()
        return response
    },
}
