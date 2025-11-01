import { describe, expect, it, jest, beforeEach } from "@jest/globals"
import { readFileSync } from "fs"
import path from "path"

import { dispatchOmniMessage } from "src/libs/omniprotocol/protocol/dispatcher"
import { OmniOpcode } from "src/libs/omniprotocol/protocol/opcodes"
import { encodeJsonRequest } from "src/libs/omniprotocol/serialization/jsonEnvelope"
import {
    decodePeerlistResponse,
    encodePeerlistSyncRequest,
    decodePeerlistSyncResponse,
    decodeNodeCallResponse,
    encodeNodeCallRequest,
    decodeStringResponse,
    decodeJsonResponse,
} from "src/libs/omniprotocol/serialization/control"
import {
    decodeMempoolResponse,
    decodeBlockResponse,
    encodeMempoolSyncRequest,
    decodeMempoolSyncResponse,
    encodeBlockSyncRequest,
    decodeBlocksResponse,
    encodeBlocksRequest,
    encodeMempoolMergeRequest,
    decodeBlockMetadata,
} from "src/libs/omniprotocol/serialization/sync"
import { decodeAddressInfoResponse } from "src/libs/omniprotocol/serialization/gcr"
import Hashing from "src/libs/crypto/hashing"
import { PrimitiveDecoder, PrimitiveEncoder } from "src/libs/omniprotocol/serialization/primitives"
import {
    decodeTransaction,
    decodeTransactionEnvelope,
} from "src/libs/omniprotocol/serialization/transaction"
import type { RPCResponse } from "@kynesyslabs/demosdk/types"

jest.mock("src/libs/network/routines/nodecalls/getPeerlist", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("src/libs/network/routines/nodecalls/getBlockByNumber", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("src/libs/blockchain/mempool_v2", () => ({
    __esModule: true,
    default: {
        getMempool: jest.fn(),
        receive: jest.fn(),
    },
}))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlocks: jest.fn(),
        getBlockByHash: jest.fn(),
        getTxByHash: jest.fn(),
    },
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/ensureGCRForUser", () => ({
    __esModule: true,
    default: jest.fn(),
}))
jest.mock("src/libs/network/manageNodeCall", () => ({
    __esModule: true,
    default: jest.fn(),
}))
const sharedStateMock = {
    getConnectionString: jest.fn(),
    version: "1.0.0",
    getInfo: jest.fn(),
}
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: sharedStateMock,
}))

const mockedGetPeerlist = jest.requireMock(
    "src/libs/network/routines/nodecalls/getPeerlist",
).default as jest.Mock
const mockedGetBlockByNumber = jest.requireMock(
    "src/libs/network/routines/nodecalls/getBlockByNumber",
).default as jest.Mock
const mockedMempool = jest.requireMock(
    "src/libs/blockchain/mempool_v2",
).default as { getMempool: jest.Mock; receive: jest.Mock }
const mockedChain = jest.requireMock(
    "src/libs/blockchain/chain",
).default as {
    getBlocks: jest.Mock
    getBlockByHash: jest.Mock
    getTxByHash: jest.Mock
}
const mockedEnsureGCRForUser = jest.requireMock(
    "src/libs/blockchain/gcr/gcr_routines/ensureGCRForUser",
).default as jest.Mock
const mockedManageNodeCall = jest.requireMock(
    "src/libs/network/manageNodeCall",
).default as jest.Mock
const mockedSharedState = jest.requireMock(
    "src/utilities/sharedState",
).getSharedState as typeof sharedStateMock

const baseContext = {
    context: {
        peerIdentity: "peer",
        connectionId: "conn",
        receivedAt: Date.now(),
        requiresAuth: false,
    },
    fallbackToHttp: jest.fn(async () => Buffer.alloc(0)),
}

describe("OmniProtocol handlers", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockedChain.getBlocks.mockReset()
        mockedChain.getBlockByHash.mockReset()
        mockedChain.getTxByHash.mockReset()
        mockedMempool.receive.mockReset()
        mockedManageNodeCall.mockReset()
        mockedSharedState.getConnectionString.mockReset()
        mockedSharedState.getInfo.mockReset()
        mockedSharedState.version = "1.0.0"
    })

    it("encodes nodeCall response", async () => {
        const payload = encodeNodeCallRequest({
            method: "getLastBlockNumber",
            params: [],
        })

        const response: RPCResponse = {
            result: 200,
            response: 123,
            require_reply: false,
            extra: { source: "http" },
        }
        mockedManageNodeCall.mockResolvedValue(response)

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.NODE_CALL,
                    sequence: 1,
                    payloadLength: payload.length,
                },
                payload,
                checksum: 0,
            },
        })

        expect(mockedManageNodeCall).toHaveBeenCalledWith({
            message: "getLastBlockNumber",
            data: {},
            muid: "",
        })

        const decoded = decodeNodeCallResponse(buffer)
        expect(decoded.status).toBe(200)
        expect(decoded.value).toBe(123)
        expect(decoded.requireReply).toBe(false)
        expect(decoded.extra).toEqual({ source: "http" })
    })

    it("encodes getPeerInfo response", async () => {
        mockedSharedState.getConnectionString.mockResolvedValue("https://node.test")

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.GET_PEER_INFO,
                    sequence: 1,
                    payloadLength: 0,
                },
                payload: Buffer.alloc(0),
                checksum: 0,
            },
        })

        const decoded = decodeStringResponse(buffer)
        expect(decoded.status).toBe(200)
        expect(decoded.value).toBe("https://node.test")
    })

    it("encodes getNodeVersion response", async () => {
        mockedSharedState.version = "2.3.4"

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.GET_NODE_VERSION,
                    sequence: 1,
                    payloadLength: 0,
                },
                payload: Buffer.alloc(0),
                checksum: 0,
            },
        })

        const decoded = decodeStringResponse(buffer)
        expect(decoded.status).toBe(200)
        expect(decoded.value).toBe("2.3.4")
    })

    it("encodes getNodeStatus response", async () => {
        const statusPayload = { status: "ok", peers: 5 }
        mockedSharedState.getInfo.mockResolvedValue(statusPayload)

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.GET_NODE_STATUS,
                    sequence: 1,
                    payloadLength: 0,
                },
                payload: Buffer.alloc(0),
                checksum: 0,
            },
        })

        const decoded = decodeJsonResponse(buffer)
        expect(decoded.status).toBe(200)
        expect(decoded.value).toEqual(statusPayload)
    })

    it("encodes getPeerlist response", async () => {
        const peerlistFixture = fixture<{
            result: number
            response: unknown
        }>("peerlist")
        mockedGetPeerlist.mockResolvedValue(peerlistFixture.response)

        const payload = Buffer.alloc(0)
        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.GET_PEERLIST,
                    sequence: 1,
                    payloadLength: 0,
                },
                payload,
                checksum: 0,
            },
        })

        const decoded = decodePeerlistResponse(buffer)
        expect(decoded.status).toBe(peerlistFixture.result)

        const defaultVerification = {
            status: false,
            message: null,
            timestamp: null,
        }
        const defaultStatus = {
            online: false,
            timestamp: null,
            ready: false,
        }

        const reconstructed = decoded.peers.map(entry => ({
            connection: { string: entry.url },
            identity: entry.identity,
            verification:
                (entry.metadata?.verification as Record<string, unknown>) ??
                defaultVerification,
            sync: {
                status: entry.syncStatus,
                block: Number(entry.blockNumber),
                block_hash: entry.blockHash.replace(/^0x/, ""),
            },
            status:
                (entry.metadata?.status as Record<string, unknown>) ??
                defaultStatus,
        }))

        expect(reconstructed).toEqual(peerlistFixture.response)
    })

    it("encodes peerlist sync response", async () => {
        const peerlistFixture = fixture<{
            result: number
            response: any[]
        }>("peerlist")

        mockedGetPeerlist.mockResolvedValue(peerlistFixture.response)

        const requestPayload = encodePeerlistSyncRequest({
            peerCount: 0,
            peerHash: Buffer.alloc(0),
        })

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.PEERLIST_SYNC,
                    sequence: 1,
                    payloadLength: requestPayload.length,
                },
                payload: requestPayload,
                checksum: 0,
            },
        })

        const decoded = decodePeerlistSyncResponse(buffer)
        expect(decoded.status).toBe(200)
        expect(decoded.peerCount).toBe(peerlistFixture.response.length)

        const expectedHash = Buffer.from(
            Hashing.sha256(JSON.stringify(peerlistFixture.response)),
            "hex",
        )
        expect(decoded.peerHash.equals(expectedHash)).toBe(true)

        const defaultVerification = {
            status: false,
            message: null,
            timestamp: null,
        }
        const defaultStatus = {
            online: false,
            timestamp: null,
            ready: false,
        }

        const reconstructed = decoded.peers.map(entry => ({
            connection: { string: entry.url },
            identity: entry.identity,
            verification:
                (entry.metadata?.verification as Record<string, unknown>) ??
                defaultVerification,
            sync: {
                status: entry.syncStatus,
                block: Number(entry.blockNumber),
                block_hash: entry.blockHash.replace(/^0x/, ""),
            },
            status:
                (entry.metadata?.status as Record<string, unknown>) ??
                defaultStatus,
        }))

        expect(reconstructed).toEqual(peerlistFixture.response)
    })

    it("encodes getMempool response", async () => {
        const mempoolFixture = fixture<{
            result: number
            response: unknown
        }>("mempool")

        mockedMempool.getMempool.mockResolvedValue(
            mempoolFixture.response,
        )

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.GET_MEMPOOL,
                    sequence: 1,
                    payloadLength: 0,
                },
                payload: Buffer.alloc(0),
                checksum: 0,
            },
        })

        const decoded = decodeMempoolResponse(buffer)
        expect(decoded.status).toBe(mempoolFixture.result)

        const transactions = decoded.transactions.map(tx =>
            decodeTransaction(tx).raw,
        )
        expect(transactions).toEqual(mempoolFixture.response)
    })

    it("encodes mempool sync response", async () => {
        const transactions = [
            { hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
            { hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        ]

        mockedMempool.getMempool.mockResolvedValue(transactions)

        const requestPayload = encodeMempoolSyncRequest({
            txCount: 0,
            mempoolHash: Buffer.alloc(0),
            blockReference: BigInt(0),
        })

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.MEMPOOL_SYNC,
                    sequence: 1,
                    payloadLength: requestPayload.length,
                },
                payload: requestPayload,
                checksum: 0,
            },
        })

        const decoded = decodeMempoolSyncResponse(buffer)
        expect(decoded.status).toBe(200)
        expect(decoded.txCount).toBe(transactions.length)

        const expectedHash = Buffer.from(
            Hashing.sha256(
                JSON.stringify(
                    transactions.map(tx => tx.hash.replace(/^0x/, "")),
                ),
            ),
            "hex",
        )
        expect(decoded.mempoolHash.equals(expectedHash)).toBe(true)

        const hashes = decoded.transactionHashes.map(hash =>
            `0x${hash.toString("hex")}`,
        )
        expect(hashes).toEqual(transactions.map(tx => tx.hash))
    })

    it("encodes block sync response", async () => {
        const hashA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const hashB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        const blocks = [
            { number: 10, hash: hashA, content: { timestamp: 111 } },
            { number: 9, hash: hashB, content: { timestamp: 99 } },
        ]

        mockedChain.getBlocks.mockResolvedValue(blocks)

        const requestPayload = encodeBlockSyncRequest({
            startBlock: BigInt(9),
            endBlock: BigInt(10),
            maxBlocks: 2,
        })

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.BLOCK_SYNC,
                    sequence: 1,
                    payloadLength: requestPayload.length,
                },
                payload: requestPayload,
                checksum: 0,
            },
        })

        const decoded = decodeBlocksResponse(buffer)
        expect(decoded.status).toBe(200)
        expect(decoded.blocks).toHaveLength(blocks.length)
        expect(Number(decoded.blocks[0].blockNumber)).toBe(blocks[0].number)
    })

    it("encodes getBlocks response", async () => {
        const hashC = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        const blocks = [
            { number: 5, hash: hashC, content: { timestamp: 500 } },
        ]

        mockedChain.getBlocks.mockResolvedValue(blocks)

        const requestPayload = encodeBlocksRequest({
            startBlock: BigInt(0),
            limit: 1,
        })

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.GET_BLOCKS,
                    sequence: 1,
                    payloadLength: requestPayload.length,
                },
                payload: requestPayload,
                checksum: 0,
            },
        })

        const decoded = decodeBlocksResponse(buffer)
        expect(decoded.status).toBe(200)
        expect(decoded.blocks[0].blockHash.replace(/^0x/, "")).toBe(hashC.slice(2))
        const metadata = decodeBlockMetadata(decoded.blocks[0].metadata)
        expect(metadata.transactionHashes).toEqual([])
    })

    it("encodes getBlockByNumber response", async () => {
        const blockFixture = fixture<{
            result: number
            response: { number: number }
        }>("block_header")

        mockedGetBlockByNumber.mockResolvedValue(blockFixture)

        const requestPayload = encodeJsonRequest({
            blockNumber: blockFixture.response.number,
        })

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.GET_BLOCK_BY_NUMBER,
                    sequence: 1,
                    payloadLength: requestPayload.length,
                },
                payload: requestPayload,
                checksum: 0,
            },
        })

        const decoded = decodeBlockResponse(buffer)
        expect(decoded.status).toBe(blockFixture.result)
        expect(Number(decoded.block.blockNumber)).toBe(
            blockFixture.response.number,
        )
        expect(decoded.block.blockHash.replace(/^0x/, "")).toBe(
            blockFixture.response.hash,
        )

        const metadata = decodeBlockMetadata(decoded.block.metadata)
        expect(metadata.previousHash).toBe(
            blockFixture.response.content.previousHash,
        )
        expect(metadata.transactionHashes).toEqual(
            blockFixture.response.content.ordered_transactions,
        )
    })

    it("encodes getBlockByHash response", async () => {
        const hashD = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        const block = { number: 7, hash: hashD, content: { timestamp: 70 } }
        mockedChain.getBlockByHash.mockResolvedValue(block as any)

        const requestPayload = PrimitiveEncoder.encodeBytes(
            Buffer.from(hashD.slice(2), "hex"),
        )

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.GET_BLOCK_BY_HASH,
                    sequence: 1,
                    payloadLength: requestPayload.length,
                },
                payload: requestPayload,
                checksum: 0,
            },
        })

        const decoded = decodeBlockResponse(buffer)
        expect(decoded.status).toBe(200)
        expect(Number(decoded.block.blockNumber)).toBe(block.number)
        const metadata = decodeBlockMetadata(decoded.block.metadata)
        expect(metadata.transactionHashes).toEqual([])
    })

    it("encodes getTxByHash response", async () => {
        const hashE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        const transaction = { hash: hashE, value: 42 }
        mockedChain.getTxByHash.mockResolvedValue(transaction as any)

        const requestPayload = PrimitiveEncoder.encodeBytes(
            Buffer.from(hashE.slice(2), "hex"),
        )

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.GET_TX_BY_HASH,
                    sequence: 1,
                    payloadLength: requestPayload.length,
                },
                payload: requestPayload,
                checksum: 0,
            },
        })

        const envelope = decodeTransactionEnvelope(buffer)
        expect(envelope.status).toBe(200)
        expect(envelope.transaction.raw).toEqual(transaction)
    })

    it("encodes mempool merge response", async () => {
        const incoming = [{ hash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }]
        mockedMempool.receive.mockResolvedValue({ success: true, mempool: incoming })

        const requestPayload = encodeMempoolMergeRequest({
            transactions: incoming.map(tx => Buffer.from(JSON.stringify(tx), "utf8")),
        })

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.MEMPOOL_MERGE,
                    sequence: 1,
                    payloadLength: requestPayload.length,
                },
                payload: requestPayload,
                checksum: 0,
            },
        })

        const decoded = decodeMempoolResponse(buffer)
        expect(decoded.status).toBe(200)
        expect(decoded.transactions).toHaveLength(incoming.length)
        const remapped = decoded.transactions.map(tx => decodeTransaction(tx).raw)
        expect(remapped).toEqual(incoming)
    })

    it("encodes gcr_getAddressInfo response", async () => {
        const addressInfoFixture = fixture<{
            result: number
            response: { pubkey: string }
        }>("address_info")

        mockedEnsureGCRForUser.mockResolvedValue(
            addressInfoFixture.response,
        )

        const requestPayload = encodeJsonRequest({
            address: addressInfoFixture.response.pubkey,
        })

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.GCR_GET_ADDRESS_INFO,
                    sequence: 1,
                    payloadLength: requestPayload.length,
                },
                payload: requestPayload,
                checksum: 0,
            },
        })

        const decoded = decodeAddressInfoResponse(buffer)
        expect(decoded.status).toBe(addressInfoFixture.result)
        expect(Number(decoded.nonce)).toBe(addressInfoFixture.response.nonce)
        expect(decoded.balance.toString()).toBe(
            BigInt(addressInfoFixture.response.balance ?? 0).toString(),
        )

        const payload = JSON.parse(
            decoded.additionalData.toString("utf8"),
        )
        expect(payload).toEqual(addressInfoFixture.response)
    })
})
const fixture = <T>(name: string): T => {
    const file = path.resolve(__dirname, "../../fixtures", `${name}.json`)
    return JSON.parse(readFileSync(file, "utf8")) as T
}
