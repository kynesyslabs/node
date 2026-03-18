import Chain from "../../blockchain/chain"
import Hashing from "../../crypto/hashing"
import getPreviousHashFromBlockNumber from "../routines/nodecalls/getPreviousHashFromBlockNumber"
import getPreviousHashFromBlockHash from "../routines/nodecalls/getPreviousHashFromBlockHash"
import getBlockHeaderByNumber from "../routines/nodecalls/getBlockHeaderByNumber"
import getBlockHeaderByHash from "../routines/nodecalls/getBlockHeaderByHash"
import getBlockByNumber from "../routines/nodecalls/getBlockByNumber"
import getBlockByHash from "../routines/nodecalls/getBlockByHash"
import getBlocks from "../routines/nodecalls/getBlocks"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

export const blockHandlers: Record<string, NodeCallHandler> = {
    getGenesisDataHash: async (_data, response) => {
        try {
            const genesisBlock = await Chain.getGenesisBlock()
            if (!genesisBlock?.content) {
                response.result = 503
                response.response = {
                    error: "STATE_NOT_READY",
                    message: "Genesis block not initialized yet",
                }
                return response
            }
            let genesisData =
                genesisBlock.content.extra?.genesisData || null

            if (typeof genesisData === "string") {
                genesisData = JSON.parse(genesisData)
            }

            response.response = Hashing.sha256(JSON.stringify(genesisData))
        } catch (error) {
            log.error(
                "[manageNodeCall] Failed to get genesis data hash: " +
                    error,
            )
            response.result = 500
            response.response = {
                error: "INTERNAL_ERROR",
                message: "Failed to get genesis data hash",
            }
        }
        return response
    },

    getPreviousHashFromBlockNumber: async (data, response) => {
        const result = await getPreviousHashFromBlockNumber(data)
        response.response = result.response
        response.extra = result.extra
        return response
    },

    getPreviousHashFromBlockHash: async (data, response) => {
        const result = await getPreviousHashFromBlockHash(data)
        response.response = result.response
        response.extra = result.extra
        return response
    },

    getBlockHeaderByNumber: async (data, response) => {
        const result = await getBlockHeaderByNumber(data)
        response.response = result.response
        response.extra = result.extra
        return response
    },

    getBlockHeaderByHash: async (data, response) => {
        const result = await getBlockHeaderByHash(data)
        response.response = result.response
        response.extra = result.extra
        return response
    },

    getLastBlockNumber: async (_data, response) => {
        log.debug("[SERVER] Received getLastBlockNumber")
        response.response = await Chain.getLastBlockNumber()
        log.debug("[CHAIN] Received reply from the database")
        return response
    },

    getLastBlock: async (_data, response) => {
        response.response = await Chain.getLastBlock()
        return response
    },

    getLastBlockHash: async (_data, response) => {
        response.response = await Chain.getLastBlockHash()
        return response
    },

    getBlockByNumber: async (data, _response) => {
        return await getBlockByNumber(data)
    },

    getBlocks: async (data, _response) => {
        return await getBlocks(data)
    },

    getBlockByHash: async (data, response) => {
        if (data.hash) {
            log.debug(`[SERVER] getBlockByHash: ${data.hash}`)
        } else if (data.blockHash) {
            log.debug(`[SERVER] getBlockByHash: ${data.blockHash}`)
            data.hash = data.blockHash
        } else {
            response.result = 400
            response.response = "No hash or blockHash specified"
            return response
        }
        try {
            const result = await getBlockByHash(data)
            response.response = result.response
            response.extra = result.extra
        } catch (e) {
            response.response = null
            response.result = 400
            response.extra = e
        }
        return response
    },

    getBlockTransactions: async (data, response) => {
        if (!data.blockHash) {
            response.result = 400
            response.response = "No block hash specified"
            return response
        }
        response.response = await Chain.getBlockTransactions(data.blockHash)
        return response
    },
}
