import Chain from "../../blockchain/chain"
import getTransactions from "../routines/nodecalls/getTransactions"
import getTransactionStatus from "../routines/nodecalls/getTransactionStatus"
import getTransactionProof from "../routines/nodecalls/getTransactionProof"
import getTxsByHashes from "../routines/nodecalls/getTxsByHashes"
import Mempool from "../../blockchain/mempool"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

const HISTORY_MAX_LIMIT = 100

/** Missing → undefined, a non-negative integer (or its digits) → the number, anything else → -1. */
function toPageInt(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined
    const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : -1
}

export const transactionHandlers: Record<string, NodeCallHandler> = {
    getTransactions: async (data, _response) => {
        return await getTransactions(data)
    },

    getTransactionStatus: async (data, _response) => {
        return await getTransactionStatus(data)
    },

    getTransactionProof: async (data, _response) => {
        return await getTransactionProof(data)
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
        // 0, missing and numeric strings keep their old meaning (`|| 100`).
        const start = toPageInt(data.start) ?? 0
        const limit = toPageInt(data.limit) || HISTORY_MAX_LIMIT
        if (start < 0 || limit < 0) {
            response.result = 400
            response.response = "start and limit must be non-negative integers"
            return response
        }
        // Unbounded pages let one caller make the node read and serialise
        // an address's whole history.
        response.response = await Chain.getTransactionHistory(
            data.address,
            data.type,
            start,
            Math.min(limit, HISTORY_MAX_LIMIT),
        )
        return response
    },

    getMempool: async (_data, response) => {
        response.response = await Mempool.getMempool()
        return response
    },
}
