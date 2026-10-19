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
        // A client recovering a lost broadcast reply reads by hash and must
        // tell "not in this chain as of height H" (keep waiting, or give up
        // once H is well past) apart from "could not look" (ask elsewhere).
        // The height is read first, so anything at or below it was searched.
        let checkedThroughBlock: number
        let tx: Awaited<ReturnType<typeof Chain.getTxByHash>>
        try {
            checkedThroughBlock = await Chain.getLastBlockNumber()
            tx = await Chain.getTxByHash(data.hash)
        } catch (e) {
            log.warning(`[SERVER] getTxByHash lookup failed: ${e}`)
            response.result = 500
            response.response = null
            response.extra = {
                reason: "lookup_failed",
                error: e instanceof Error ? e.message : String(e),
            }
            return response
        }
        if (!tx) {
            response.result = 404
            response.response = null
            response.extra = { reason: "not_found", checkedThroughBlock }
            return response
        }
        response.response = tx
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
