import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { getSharedState } from "src/utilities/sharedState"
import getPeerInfo from "../routines/nodecalls/getPeerInfo"
import getPeerlist from "../routines/nodecalls/getPeerlist"
import Hashing from "../../crypto/hashing"
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
        const peerlist = await getPeerlist()
        response.response = Hashing.sha256(JSON.stringify(peerlist))
        log.custom(
            "manageNodeCall",
            "Peerlist hash: " + response.response,
            true,
        )
        return response
    },

    getPeerIdentity: async (_data, response) => {
        response.response = uint8ArrayToHex(
            getSharedState.keypair.publicKey as Uint8Array,
        )
        return response
    },

    getPeerTime: async (_data, response) => {
        response.response = new Date().getTime()
        return response
    },
}
