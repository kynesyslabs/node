import { beforeAll, describe, expect, it, mock } from "bun:test"

const MEMBER = "aa".repeat(32)
const OTHER_MEMBER = "bb".repeat(32)
const OUTSIDER = "cc".repeat(32)
const SIGNATURE = "11".repeat(64)

const state = {
    publicKeyHex: MEMBER,
    signingAlgorithm: "ed25519",
    candidateBlock: undefined as any,
}

mock.module("src/utilities/sharedState", () => ({
    getSharedState: state,
    __esModule: true,
}))
mock.module("src/utilities/logger", () => ({
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        custom: () => {},
    },
    __esModule: true,
}))
mock.module("src/libs/blockchain/validation/txValidatorPool", () => ({
    default: {
        getInstance: () => ({ verify: async () => true }),
    },
    __esModule: true,
}))
mock.module("@kynesyslabs/demosdk/encryption", () => ({
    hexToUint8Array: (value: string) => new Uint8Array(value.length / 2),
    __esModule: true,
}))
mock.module("src/libs/blockchain/mempool", () => ({
    default: { getTransactionsByHashes: async () => [] },
    __esModule: true,
}))
mock.module("src/libs/network/server_rpc", () => ({
    emptyResponse: { result: 0, response: "", extra: {} },
    __esModule: true,
}))
mock.module("src/libs/peer/PeerManager", () => ({
    default: { getInstance: () => ({ getPeer: () => undefined }) },
    __esModule: true,
}))
mock.module("src/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    default: async () => ({ commonValidatorSeed: "seed" }),
    __esModule: true,
}))
mock.module("src/libs/consensus/v2/routines/getShard", () => ({
    default: async () => [
        { identity: MEMBER, connection: { string: MEMBER } },
        { identity: OTHER_MEMBER, connection: { string: OTHER_MEMBER } },
    ],
    __esModule: true,
}))
mock.module("src/libs/consensus/v2/routines/ensureCandidateBlockFormed", () => ({
    default: async () => true,
    __esModule: true,
}))
mock.module("src/libs/consensus/v2/routines/networkAheadVeto", () => ({
    isNetworkAhead: async () => false,
    __esModule: true,
}))
mock.module("src/libs/blockchain/chain", () => ({
    default: { getBlockByNumber: async () => null },
    __esModule: true,
}))
mock.module("src/libs/blockchain/validation/verifyBlock", () => ({
    checkTimestampAgainstParent: () => ({ valid: true }),
    __esModule: true,
}))

const peer = (identity: string) => ({ identity, connection: { string: identity } })

beforeAll(() => {
    state.candidateBlock = {
        hash: "candidate-hash",
        number: 10,
        content: { timestamp: 10, ordered_transactions: [] },
        validation_data: { signatures: {} },
    }
})

describe("consensus signature collection", () => {
    it("broadcastBlockHash merges only signatures from current shard members", async () => {
        const { broadcastBlockHash } = await import("./broadcastBlockHash")
        const block = structuredClone(state.candidateBlock)
        const peers = [
            {
                ...peer(MEMBER),
                longCall: async () => ({
                    result: 200,
                    response: MEMBER,
                    extra: {
                        signatures: {
                            [MEMBER]: SIGNATURE,
                            [OUTSIDER]: SIGNATURE,
                        },
                    },
                }),
            },
        ] as any

        const [pro, con] = await broadcastBlockHash(block, peers)

        expect([pro, con]).toEqual([1, 0])
        expect(block.validation_data.signatures).toEqual({
            [MEMBER]: SIGNATURE,
        })
        expect(block.validation_data.signatures[OUTSIDER]).toBeUndefined()
    })

    it("manageProposeBlockHash does not merge non-shard signatures", async () => {
        const { default: manageProposeBlockHash } = await import(
            "./manageProposeBlockHash"
        )
        const response = await manageProposeBlockHash(
            "candidate-hash",
            {
                signatures: {
                    [MEMBER]: SIGNATURE,
                    [OUTSIDER]: SIGNATURE,
                },
            },
            MEMBER,
        )

        expect(response.result).toBe(200)
        expect(state.candidateBlock.validation_data.signatures).toEqual({
            [MEMBER]: SIGNATURE,
        })
        expect(
            state.candidateBlock.validation_data.signatures[OUTSIDER],
        ).toBeUndefined()
    })
})
