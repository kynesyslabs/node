/**
 * Chain identity: the chain id, block 0 hash and genesis data hash a client
 * pins, which must be the very values this node binds signatures to and
 * checks its genesis against at boot, reachable through the nodeCall
 * registry that HTTP and OmniProtocol both dispatch through.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import { createHash } from "node:crypto"

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const getGenesisBlock = jest.fn(async () => null as any)
const sharedState: Record<string, any> = {}

jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: { getGenesisBlock } }))
jest.mock("src/utilities/sharedState", () => ({ __esModule: true, default: class {}, getSharedState: sharedState }))
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { cloneDefaultForkConfig, loadForkConfigFromGenesis, txSignatureContext } = await import("@/forks")
const { blockPinProblem, parseGenesisPin, restartGenesisProblems } = await import(
    "src/libs/blockchain/genesis/genesisPin"
)
const { default: getChainIdentity } = await import("./getChainIdentity")
const { handlerRegistry } = await import("../../handlers")

const GENESIS_DATA = {
    properties: { id: 4242, name: "identity test chain" },
    balances: [[`0x${"a1".repeat(32)}`, "1000"]],
    forks: { signatureDomain: { activationHeight: 0 } },
}

function genesisBlock(genesisData: unknown = JSON.stringify(GENESIS_DATA)) {
    const content = { previousHash: "0".repeat(64), number: 0, extra: { genesisData } }
    return { number: 0, hash: sha256(JSON.stringify(content)), content }
}

beforeEach(() => {
    for (const key of Object.keys(sharedState)) delete sharedState[key]
    sharedState.forkConfig = cloneDefaultForkConfig()
    sharedState.chainId = null
    loadForkConfigFromGenesis(GENESIS_DATA)
    const block = genesisBlock()
    sharedState.genesisBlockHash = block.hash
    getGenesisBlock.mockReset()
    getGenesisBlock.mockResolvedValue(block)
})

describe("getChainIdentity", () => {
    it("answers the chain id, block 0 hash and genesis data hash in one call", async () => {
        const reply = await getChainIdentity()
        expect(reply.result).toBe(200)
        expect(Object.keys(reply.response).sort()).toEqual(["chainId", "genesisDataHash", "genesisHash"])
        expect(reply.response.chainId).toBe(4242)
        expect(reply.response.genesisHash).toBe(genesisBlock().hash)
    })

    it("answers the values the node enforces", async () => {
        const { response } = await getChainIdentity()
        // The id every signature binds to under signatureDomain.
        expect(response.chainId).toBe(txSignatureContext(0).chainId)
        // The pins that refuse any other genesis at boot accept exactly these.
        const stored = GENESIS_DATA
        expect(restartGenesisProblems({ storedGenesisData: stored, fileGenesisData: stored, pin: parseGenesisPin(response.genesisDataHash) })).toEqual([])
        expect(restartGenesisProblems({ storedGenesisData: stored, fileGenesisData: stored, pin: sha256("another genesis") })).not.toEqual([])
        expect(blockPinProblem(response.genesisHash, parseGenesisPin(response.genesisHash, "EXPECTED_GENESIS_BLOCK_HASH"), false)).toBeNull()
    })

    it("reads genesis data stored as an object or as twice-encoded text the same way", async () => {
        const once = (await getChainIdentity()).response.genesisDataHash
        getGenesisBlock.mockResolvedValue({ ...genesisBlock(), content: { ...genesisBlock().content, extra: { genesisData: GENESIS_DATA } } })
        expect((await getChainIdentity()).response.genesisDataHash).toBe(once)
        getGenesisBlock.mockResolvedValue({
            ...genesisBlock(),
            content: { ...genesisBlock().content, extra: { genesisData: JSON.stringify(JSON.stringify(GENESIS_DATA)) } },
        })
        expect((await getChainIdentity()).response.genesisDataHash).toBe(once)
    })

    it("answers chainId null for a genesis that declares none", async () => {
        sharedState.forkConfig = cloneDefaultForkConfig()
        loadForkConfigFromGenesis({ ...GENESIS_DATA, properties: { name: "no id" }, forks: {} })
        expect((await getChainIdentity()).response.chainId).toBeNull()
    })

    it("answers 503 before block 0 is loaded and 500 when it is not the block booted on", async () => {
        sharedState.genesisBlockHash = null
        const early = await getChainIdentity()
        expect(early.result).toBe(503)
        expect(early.extra).toEqual({ reason: "state_not_ready" })

        sharedState.genesisBlockHash = sha256("another block 0")
        const other = await getChainIdentity()
        expect(other.result).toBe(500)
        expect(other.extra).toMatchObject({ reason: "lookup_failed" })

        sharedState.genesisBlockHash = genesisBlock().hash
        getGenesisBlock.mockRejectedValue(new Error("connection lost"))
        expect((await getChainIdentity()).result).toBe(500)
    })

    it("is a registered nodeCall", async () => {
        const reply = await handlerRegistry.getChainIdentity({}, { result: 200, response: null, require_reply: false, extra: null }, "")
        expect(reply.result).toBe(200)
        expect(reply.response.chainId).toBe(4242)
    })
})
