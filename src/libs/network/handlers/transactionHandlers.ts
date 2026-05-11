import Chain from "../../blockchain/chain"
import getTransactions from "../routines/nodecalls/getTransactions"
import getTransactionStatus from "../routines/nodecalls/getTransactionStatus"
import getTxsByHashes from "../routines/nodecalls/getTxsByHashes"
import Mempool from "../../blockchain/mempool"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

export const transactionHandlers: Record<string, NodeCallHandler> = {
    getTransactions: async (data, _response) => {
        return await getTransactions(data)
    },

    getTransactionStatus: async (data, _response) => {
        return await getTransactionStatus(data)
    },

    getTxByHash: async (data, response) => {
        if (!data.hash) {
            response.result = 400
            response.response = "No hash specified"
            return response
        }
        log.debug(`[SERVER] getTxByHash: ${data.hash}`)
        try {
            response.response = await Chain.getTxByHash(data.hash)
        } catch (e) {
            response.response = null
            response.result = 400
            response.extra = e
        }
        if (!response.response) {
            response.result = 400
            response.response = "error"
        }
        return response
    },

    getTxsByHashes: async (data, _response) => {
        return await getTxsByHashes(data)
    },

    getAllTxs: async (_data, response) => {
        // NOTE: Endpoint deprecated
        response.response = {}
        return response
    },

    getTransactionHistory: async (data, response) => {
        if (!data.address || !data.type) {
            response.result = 400
            response.response = "No address or type specified"
            return response
        }
        response.response = await Chain.getTransactionHistory(
            data.address,
            data.type,
            data.start || 0,
            data.limit || 100,
        )
        return response
    },

    getMempool: async (_data, response) => {
        response.response = await Mempool.getMempool()
        return response
    },
}
