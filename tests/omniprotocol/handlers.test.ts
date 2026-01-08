import { beforeAll, describe, expect, it, jest, beforeEach } from "@jest/globals"

jest.mock("@kynesyslabs/demosdk/encryption", () => ({
    __esModule: true,
    ucrypto: {
        getIdentity: jest.fn(async () => ({
            publicKey: new Uint8Array(32),
            algorithm: "ed25519",
        })),
        sign: jest.fn(async () => ({
            signature: new Uint8Array([1, 2, 3, 4]),
        })),
        verify: jest.fn(async () => true),
    },
    uint8ArrayToHex: jest.fn((input: Uint8Array) =>
        Buffer.from(input).toString("hex"),
    ),
    hexToUint8Array: jest.fn((hex: string) => {
        const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
        return new Uint8Array(Buffer.from(normalized, "hex"))
    }),
}))
jest.mock("@kynesyslabs/demosdk/build/multichain/core", () => ({
    __esModule: true,
    default: {},
}))
jest.mock("@kynesyslabs/demosdk/build/multichain/localsdk", () => ({
    __esModule: true,
    default: {},
}))
import { readFileSync } from "fs"
import path from "path"
import type { RPCResponse } from "@kynesyslabs/demosdk/types"

let dispatchOmniMessage: typeof import("src/libs/omniprotocol/protocol/dispatcher")
    ["dispatchOmniMessage"]
let OmniOpcode: typeof import("src/libs/omniprotocol/protocol/opcodes")["OmniOpcode"]
let encodeJsonRequest: typeof import("src/libs/omniprotocol/serialization/jsonEnvelope")
    ["encodeJsonRequest"]
let decodePeerlistResponse: typeof import("src/libs/omniprotocol/serialization/control")
    ["decodePeerlistResponse"]
let encodePeerlistSyncRequest: typeof import("src/libs/omniprotocol/serialization/control")
    ["encodePeerlistSyncRequest"]
let decodePeerlistSyncResponse: typeof import("src/libs/omniprotocol/serialization/control")
    ["decodePeerlistSyncResponse"]
let decodeNodeCallResponse: typeof import("src/libs/omniprotocol/serialization/control")
    ["decodeNodeCallResponse"]
let encodeNodeCallRequest: typeof import("src/libs/omniprotocol/serialization/control")
    ["encodeNodeCallRequest"]
let decodeStringResponse: typeof import("src/libs/omniprotocol/serialization/control")
    ["decodeStringResponse"]
let decodeJsonResponse: typeof import("src/libs/omniprotocol/serialization/control")
    ["decodeJsonResponse"]
let decodeMempoolResponse: typeof import("src/libs/omniprotocol/serialization/sync")
    ["decodeMempoolResponse"]
let decodeBlockResponse: typeof import("src/libs/omniprotocol/serialization/sync")
    ["decodeBlockResponse"]
let encodeMempoolSyncRequest: typeof import("src/libs/omniprotocol/serialization/sync")
    ["encodeMempoolSyncRequest"]
let decodeMempoolSyncResponse: typeof import("src/libs/omniprotocol/serialization/sync")
    ["decodeMempoolSyncResponse"]
let encodeBlockSyncRequest: typeof import("src/libs/omniprotocol/serialization/sync")
    ["encodeBlockSyncRequest"]
let decodeBlocksResponse: typeof import("src/libs/omniprotocol/serialization/sync")
    ["decodeBlocksResponse"]
let encodeBlocksRequest: typeof import("src/libs/omniprotocol/serialization/sync")
    ["encodeBlocksRequest"]
let encodeMempoolMergeRequest: typeof import("src/libs/omniprotocol/serialization/sync")
    ["encodeMempoolMergeRequest"]
let decodeBlockMetadata: typeof import("src/libs/omniprotocol/serialization/sync")
    ["decodeBlockMetadata"]
let decodeAddressInfoResponse: typeof import("src/libs/omniprotocol/serialization/gcr")
    ["decodeAddressInfoResponse"]
let Hashing: any
let PrimitiveDecoder: typeof import("src/libs/omniprotocol/serialization/primitives")
    ["PrimitiveDecoder"]
let PrimitiveEncoder: typeof import("src/libs/omniprotocol/serialization/primitives")
    ["PrimitiveEncoder"]
let decodeTransaction: typeof import("src/libs/omniprotocol/serialization/transaction")
    ["decodeTransaction"]
let decodeTransactionEnvelope: typeof import("src/libs/omniprotocol/serialization/transaction")
    ["decodeTransactionEnvelope"]
let encodeProtocolDisconnect: typeof import("src/libs/omniprotocol/serialization/meta")
    ["encodeProtocolDisconnect"]
let encodeProtocolError: typeof import("src/libs/omniprotocol/serialization/meta")
    ["encodeProtocolError"]
let encodeVersionNegotiateResponse: typeof import("src/libs/omniprotocol/serialization/meta")
    ["encodeVersionNegotiateResponse"]

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
jest.mock("src/utilities/sharedState", () => {
    const sharedState = {
        getConnectionString: jest.fn(),
        version: "1.0.0",
        getInfo: jest.fn(),
    }

    return {
        __esModule: true,
        getSharedState: sharedState,
        __sharedStateMock: sharedState,
    }
})

let mockedGetPeerlist: jest.Mock
let mockedGetBlockByNumber: jest.Mock
let mockedMempool: { getMempool: jest.Mock; receive: jest.Mock }
let mockedChain: {
    getBlocks: jest.Mock
    getBlockByHash: jest.Mock
    getTxByHash: jest.Mock
}
let mockedEnsureGCRForUser: jest.Mock
let mockedManageNodeCall: jest.Mock
let sharedStateMock: {
    getConnectionString: jest.Mock<Promise<string>, []>
    version: string
    getInfo: jest.Mock<Promise<unknown>, []>
}

beforeAll(async () => {
    ({ dispatchOmniMessage } = await import("src/libs/omniprotocol/protocol/dispatcher"))
    ;({ OmniOpcode } = await import("src/libs/omniprotocol/protocol/opcodes"))
    ;({ encodeJsonRequest } = await import("src/libs/omniprotocol/serialization/jsonEnvelope"))

    const controlSerializers = await import("src/libs/omniprotocol/serialization/control")
    decodePeerlistResponse = controlSerializers.decodePeerlistResponse
    encodePeerlistSyncRequest = controlSerializers.encodePeerlistSyncRequest
    decodePeerlistSyncResponse = controlSerializers.decodePeerlistSyncResponse
    decodeNodeCallResponse = controlSerializers.decodeNodeCallResponse
    encodeNodeCallRequest = controlSerializers.encodeNodeCallRequest
    decodeStringResponse = controlSerializers.decodeStringResponse
    decodeJsonResponse = controlSerializers.decodeJsonResponse

    const syncSerializers = await import("src/libs/omniprotocol/serialization/sync")
    decodeMempoolResponse = syncSerializers.decodeMempoolResponse
    decodeBlockResponse = syncSerializers.decodeBlockResponse
    encodeMempoolSyncRequest = syncSerializers.encodeMempoolSyncRequest
    decodeMempoolSyncResponse = syncSerializers.decodeMempoolSyncResponse
    encodeBlockSyncRequest = syncSerializers.encodeBlockSyncRequest
    decodeBlocksResponse = syncSerializers.decodeBlocksResponse
    encodeBlocksRequest = syncSerializers.encodeBlocksRequest
    encodeMempoolMergeRequest = syncSerializers.encodeMempoolMergeRequest
    decodeBlockMetadata = syncSerializers.decodeBlockMetadata

    ;({ decodeAddressInfoResponse } = await import("src/libs/omniprotocol/serialization/gcr"))

    Hashing = (await import("src/libs/crypto/hashing")).default

    const primitives = await import("src/libs/omniprotocol/serialization/primitives")
    PrimitiveDecoder = primitives.PrimitiveDecoder
    PrimitiveEncoder = primitives.PrimitiveEncoder

    const transactionSerializers = await import("src/libs/omniprotocol/serialization/transaction")
    decodeTransaction = transactionSerializers.decodeTransaction
    decodeTransactionEnvelope = transactionSerializers.decodeTransactionEnvelope

    const metaSerializers = await import("src/libs/omniprotocol/serialization/meta")
    encodeProtocolDisconnect = metaSerializers.encodeProtocolDisconnect
    encodeProtocolError = metaSerializers.encodeProtocolError
    encodeVersionNegotiateResponse = metaSerializers.encodeVersionNegotiateResponse

    mockedGetPeerlist = (await import("src/libs/network/routines/nodecalls/getPeerlist"))
        .default as jest.Mock
    mockedGetBlockByNumber = (await import("src/libs/network/routines/nodecalls/getBlockByNumber"))
        .default as jest.Mock
    mockedMempool = (await import("src/libs/blockchain/mempool_v2"))
        .default as { getMempool: jest.Mock; receive: jest.Mock }
    mockedChain = (await import("src/libs/blockchain/chain"))
        .default as {
            getBlocks: jest.Mock
            getBlockByHash: jest.Mock
            getTxByHash: jest.Mock
        }
    mockedEnsureGCRForUser = (await import("src/libs/blockchain/gcr/gcr_routines/ensureGCRForUser"))
        .default as jest.Mock
    mockedManageNodeCall = (await import("src/libs/network/manageNodeCall"))
        .default as jest.Mock
    sharedStateMock = (await import("src/utilities/sharedState"))
        .getSharedState as unknown as {
            getConnectionString: jest.Mock<Promise<string>, []>
            version: string
            getInfo: jest.Mock<Promise<unknown>, []>
        }
})

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
        sharedStateMock.getConnectionString.mockReset().mockResolvedValue("")
        sharedStateMock.getInfo.mockReset().mockResolvedValue({})
        sharedStateMock.version = "1.0.0"
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

    it("encodes proto version negotiation response", async () => {
        const request = Buffer.concat([
            PrimitiveEncoder.encodeUInt16(1),
            PrimitiveEncoder.encodeUInt16(2),
            PrimitiveEncoder.encodeUInt16(2),
            PrimitiveEncoder.encodeUInt16(1),
            PrimitiveEncoder.encodeUInt16(2),
        ])

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.PROTO_VERSION_NEGOTIATE,
                    sequence: 1,
                    payloadLength: request.length,
                },
                payload: request,
                checksum: 0,
            },
        })

        const response = PrimitiveDecoder.decodeUInt16(buffer, 0)
        const negotiated = PrimitiveDecoder.decodeUInt16(buffer, response.bytesRead)
        expect(response.value).toBe(200)
        expect(negotiated.value).toBe(1)
    })

    it("encodes proto capability exchange response", async () => {
        const request = Buffer.concat([
            PrimitiveEncoder.encodeUInt16(1),
            PrimitiveEncoder.encodeUInt16(0x0001),
            PrimitiveEncoder.encodeUInt16(0x0001),
            PrimitiveEncoder.encodeBoolean(true),
        ])

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.PROTO_CAPABILITY_EXCHANGE,
                    sequence: 1,
                    payloadLength: request.length,
                },
                payload: request,
                checksum: 0,
            },
        })

        const status = PrimitiveDecoder.decodeUInt16(buffer, 0)
        const count = PrimitiveDecoder.decodeUInt16(buffer, status.bytesRead)
        expect(status.value).toBe(200)
        expect(count.value).toBeGreaterThan(0)
    })

    it("handles proto_error without response", async () => {
        const payload = encodeProtocolError({ errorCode: 0x0004, message: "Invalid opcode" })

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.PROTO_ERROR,
                    sequence: 1,
                    payloadLength: payload.length,
                },
                payload,
                checksum: 0,
            },
        })

        expect(buffer.length).toBe(0)
    })

    it("encodes proto_ping response", async () => {
        const now = BigInt(Date.now())
        const payload = PrimitiveEncoder.encodeUInt64(now)

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.PROTO_PING,
                    sequence: 1,
                    payloadLength: payload.length,
                },
                payload,
                checksum: 0,
            },
        })

        const status = PrimitiveDecoder.decodeUInt16(buffer, 0)
        const timestamp = PrimitiveDecoder.decodeUInt64(buffer, status.bytesRead)
        expect(status.value).toBe(200)
        expect(timestamp.value).toBe(now)
    })

    it("handles proto_disconnect without response", async () => {
        const payload = encodeProtocolDisconnect({ reason: 0x01, message: "Shutdown" })

        const buffer = await dispatchOmniMessage({
            ...baseContext,
            message: {
                header: {
                    version: 1,
                    opcode: OmniOpcode.PROTO_DISCONNECT,
                    sequence: 1,
                    payloadLength: payload.length,
                },
                payload,
                checksum: 0,
            },
        })

        expect(buffer.length).toBe(0)
    })

    it("encodes getPeerInfo response", async () => {
        sharedStateMock.getConnectionString.mockResolvedValue("https://node.test")

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
        sharedStateMock.version = "2.3.4"

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
        sharedStateMock.getInfo.mockResolvedValue(statusPayload)

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
