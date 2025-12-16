import { OmniHandler } from "../../types/message"
import { decodeJsonRequest } from "../../serialization/jsonEnvelope"
import {
    decodeBlockHashRequest,
    decodeBlockSyncRequest,
    decodeBlocksRequest,
    decodeMempoolMergeRequest,
    decodeMempoolSyncRequest,
    decodeTransactionHashRequest,
    encodeBlockResponse,
    encodeBlockSyncResponse,
    encodeBlocksResponse,
    encodeBlockMetadata,
    encodeMempoolResponse,
    encodeMempoolSyncResponse,
    BlockEntryPayload,
} from "../../serialization/sync"
import {
    decodeTransaction,
    encodeTransaction,
    encodeTransactionEnvelope,
} from "../../serialization/transaction"
import { errorResponse, encodeResponse } from "./utils"

export const handleGetMempool: OmniHandler = async () => {
    const { default: mempoolModule } = await import("src/libs/blockchain/mempool_v2")
    const mempool = await mempoolModule.getMempool()

    const serializedTransactions = mempool.map(tx => encodeTransaction(tx))

    return encodeMempoolResponse({
        status: 200,
        transactions: serializedTransactions,
    })
}

export const handleMempoolSync: OmniHandler = async ({ message }) => {
    if (message.payload && message.payload.length > 0) {
        decodeMempoolSyncRequest(message.payload)
    }

    const { default: mempoolModule } = await import("src/libs/blockchain/mempool_v2")
    const { default: hashing } = await import("src/libs/crypto/hashing")

    const mempool = await mempoolModule.getMempool()
    const transactionHashesHex = mempool
        .map(tx => (typeof tx.hash === "string" ? tx.hash : ""))
        .filter(Boolean)
        .map(hash => hash.replace(/^0x/, ""))

    const mempoolHashHex = hashing.sha256(
        JSON.stringify(transactionHashesHex),
    )

    const transactionBuffers = transactionHashesHex.map(hash =>
        Buffer.from(hash, "hex"),
    )

    return encodeMempoolSyncResponse({
        status: 200,
        txCount: mempool.length,
        mempoolHash: Buffer.from(mempoolHashHex, "hex"),
        transactionHashes: transactionBuffers,
    })
}

interface GetBlockByNumberRequest {
    blockNumber: number
}

function toBlockEntry(block: any): BlockEntryPayload {
    const timestamp =
        typeof block?.content?.timestamp === "number"
            ? block.content.timestamp
            : typeof block?.timestamp === "number"
              ? block.timestamp
              : 0

    return {
        blockNumber: BigInt(block?.number ?? 0),
        blockHash: block?.hash ?? "",
        timestamp: BigInt(timestamp),
        metadata: encodeBlockMetadata({
            previousHash: block?.content?.previousHash ?? "",
            proposer: block?.proposer ?? "",
            nextProposer: block?.next_proposer ?? "",
            status: block?.status ?? "",
            transactionHashes: Array.isArray(block?.content?.ordered_transactions)
                ? block.content.ordered_transactions.map((tx: unknown) => String(tx))
                : [],
        }),
    }
}

export const handleGetBlockByNumber: OmniHandler = async ({ message }) => {
    if (!message.payload || message.payload.length === 0) {
        return encodeResponse(
            errorResponse(400, "Missing payload for getBlockByNumber"),
        )
    }

    const payload = decodeJsonRequest<GetBlockByNumberRequest>(
        message.payload,
    )

    if (!payload?.blockNumber && payload?.blockNumber !== 0) {
        return encodeResponse(
            errorResponse(400, "blockNumber is required in payload"),
        )
    }

    const { default: getBlockByNumber } = await import(
        "src/libs/network/routines/nodecalls/getBlockByNumber"
    )

    const response = await getBlockByNumber({
        blockNumber: payload.blockNumber,
    })

    const blockData = (response.response ?? {}) as {
        number?: number
        hash?: string
        content?: { timestamp?: number }
    }

    return encodeBlockResponse({
        status: response.result,
        block: toBlockEntry(blockData),
    })
}

export const handleBlockSync: OmniHandler = async ({ message }) => {
    if (!message.payload || message.payload.length === 0) {
        return encodeBlockSyncResponse({ status: 400, blocks: [] })
    }

    const request = decodeBlockSyncRequest(message.payload)
    const { default: chain } = await import("src/libs/blockchain/chain")

    const start = Number(request.startBlock)
    const end = Number(request.endBlock)
    const max = request.maxBlocks === 0 ? Number.MAX_SAFE_INTEGER : request.maxBlocks

    const range = end >= start ? end - start + 1 : 0
    const limit = Math.min(Math.max(range, 0) || max, max)

    if (limit <= 0) {
        return encodeBlockSyncResponse({ status: 400, blocks: [] })
    }

    const blocks = await chain.getBlocks(start, limit)

    return encodeBlockSyncResponse({
        status: blocks.length > 0 ? 200 : 404,
        blocks: blocks.map(toBlockEntry),
    })
}

export const handleGetBlocks: OmniHandler = async ({ message }) => {
    if (!message.payload || message.payload.length === 0) {
        return encodeBlocksResponse({ status: 400, blocks: [] })
    }

    const request = decodeBlocksRequest(message.payload)
    const { default: chain } = await import("src/libs/blockchain/chain")

    const startParam = request.startBlock === BigInt(0) ? "latest" : Number(request.startBlock)
    const limit = request.limit === 0 ? 1 : request.limit

    const blocks = await chain.getBlocks(startParam as any, limit)

    return encodeBlocksResponse({
        status: blocks.length > 0 ? 200 : 404,
        blocks: blocks.map(toBlockEntry),
    })
}

export const handleGetBlockByHash: OmniHandler = async ({ message }) => {
    if (!message.payload || message.payload.length === 0) {
        return encodeBlockResponse({
            status: 400,
            block: toBlockEntry({}),
        })
    }

    const request = decodeBlockHashRequest(message.payload)
    const { default: chain } = await import("src/libs/blockchain/chain")

    const block = await chain.getBlockByHash(`0x${request.hash.toString("hex")}`)
    if (!block) {
        return encodeBlockResponse({
            status: 404,
            block: toBlockEntry({}),
        })
    }

    return encodeBlockResponse({
        status: 200,
        block: toBlockEntry(block),
    })
}

export const handleGetTxByHash: OmniHandler = async ({ message }) => {
    if (!message.payload || message.payload.length === 0) {
        return encodeTransactionResponse({
            status: 400,
            transaction: Buffer.alloc(0),
        })
    }

    const request = decodeTransactionHashRequest(message.payload)
    const { default: chain } = await import("src/libs/blockchain/chain")

    const tx = await chain.getTxByHash(`0x${request.hash.toString("hex")}`)

    if (!tx) {
        return encodeTransactionEnvelope({
            status: 404,
            transaction: Buffer.alloc(0),
        })
    }

    return encodeTransactionEnvelope({
        status: 200,
        transaction: encodeTransaction(tx),
    })
}

export const handleMempoolMerge: OmniHandler = async ({ message }) => {
    if (!message.payload || message.payload.length === 0) {
        return encodeMempoolResponse({ status: 400, transactions: [] })
    }

    const request = decodeMempoolMergeRequest(message.payload)

    const transactions = request.transactions.map(buffer => {
        const text = buffer.toString("utf8").trim()
        if (text.startsWith("{")) {
            try {
                return JSON.parse(text)
            } catch {
                return null
            }
        }

        try {
            return decodeTransaction(buffer).raw
        } catch {
            return null
        }
    })

    if (transactions.includes(null)) {
        return encodeMempoolResponse({ status: 400, transactions: [] })
    }

    const { default: mempoolModule } = await import("src/libs/blockchain/mempool_v2")
    const result = await mempoolModule.receive(transactions as any)

    const serializedResponse = (result.mempool ?? []).map(tx =>
        encodeTransaction(tx),
    )

    return encodeMempoolResponse({
        status: result.success ? 200 : 400,
        transactions: serializedResponse,
    })
}
