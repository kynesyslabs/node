/**
 * verifyBlock's signature path with real ed25519: committee members sign
 * the block hash with the SDK's unified crypto, the same primitive the
 * node's signing worker uses, and verification runs through a started
 * TxValidatorPool. Only chain storage and the validator set are stubbed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import { getUnifiedCryptoInstance, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

const sharedState: Record<string, any> = {
    signingAlgorithm: "ed25519",
    shardSize: 4,
    publicKeyHex: "",
    lastBlockNumber: 9,
    lastBlockHash: "hash-9",
    forkConfig: {
        quorumParity: { activationHeight: 0 },
        committeeBinding: { activationHeight: 0 },
    },
    identity: { masterSeed: new Uint8Array(128).fill(7) },
    getBlockTimestampMinDelta: () => 1,
    getBlockTimestampTolerance: () => 60,
}

let peerlist: string[] = []

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}))
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    default: sharedState,
    getSharedState: sharedState,
}))
jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => 2000,
}))
jest.mock("src/libs/debug/nonceTrace", () => ({
    debugAssertionsEnabled: () => false,
}))
jest.mock("./verifyBlockTxSignatures", () => ({
    verifyBlockTxSignatures: async () => ({ valid: true }),
}))
class FakePeerManager {
    static getInstance() {
        return new FakePeerManager()
    }
    async getOnlinePeers() {
        return []
    }
    getPeers() {
        return []
    }
    getPeer() {
        return undefined
    }
}
jest.mock("src/libs/peer/PeerManager", () => ({
    __esModule: true,
    default: FakePeerManager,
}))
jest.mock("src/libs/peer", () => ({
    Peer: class {},
    PeerManager: FakePeerManager,
}))

const storedBlock = (n: number) => ({
    number: n,
    hash: `hash-${n}`,
    content: { peerlist, timestamp: 1000 + n },
})
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: async (n: number) => (n >= 0 && n <= 9 ? storedBlock(n) : null),
        getGenesisBlockHash: async () => "hash-0",
    },
}))
jest.mock("src/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorsAtBlock: async () => peerlist.map(address => ({ address })),
    },
}))

const { verifyBlock } = await import("./verifyBlock")
const { getBoundCommittee, __resetValidatorCache: resetPoolCache } = await import(
    "src/libs/consensus/v2/routines/getShard"
)
const validatorPool = (await import("./txValidatorPool")).default.getInstance()
const sha256 = (await import("src/libs/crypto/hashing")).default.sha256

interface Signer {
    identity: string
    sign: (message: string) => Promise<string>
}

async function makeSigner(index: number): Promise<Signer> {
    const seed = new Uint8Array(128).fill(index + 1)
    const crypto = getUnifiedCryptoInstance(`committee-test-${index}`, seed)
    await crypto.generateIdentity("ed25519", seed)
    const { publicKey } = await crypto.getIdentity("ed25519")
    return {
        identity: uint8ArrayToHex(publicKey as Uint8Array),
        sign: async message => {
            const signed = await crypto.sign("ed25519", new TextEncoder().encode(message))
            return uint8ArrayToHex(signed.signature as Uint8Array)
        },
    }
}

function makeBlock(nonce: string) {
    const content = { previousHash: "hash-9", timestamp: 1500, nonce }
    return {
        number: 10,
        hash: sha256(JSON.stringify(content)),
        content,
        validation_data: { signatures: {} as Record<string, string> },
    } as any
}

async function signedBy(block: any, signers: Signer[]) {
    for (const signer of signers) {
        block.validation_data.signatures[signer.identity] = await signer.sign(block.hash)
    }
    return block
}

let signers: Signer[] = []
let committee: string[] = []
let committeeSigners: Signer[] = []
let outsiders: Signer[] = []

let allSigners: Signer[] = []
let node: Signer

beforeAll(async () => {
    allSigners = await Promise.all(Array.from({ length: 14 }, (_, i) => makeSigner(i)))
    signers = allSigners.slice(0, 6)
    await validatorPool.start(1)
    // The pool signs as the node, from the master seed, the way createBlock does.
    const nodeIdentity = (await makeSigner(6)).identity
    node = {
        identity: nodeIdentity,
        sign: async message => {
            const signed = await validatorPool.sign(
                "ed25519",
                new TextEncoder().encode(message),
            )
            return uint8ArrayToHex(signed.signature as Uint8Array)
        },
    }
})

afterAll(async () => {
    await validatorPool.stop()
})

beforeEach(async () => {
    resetPoolCache()
    sharedState.shardSize = 4
    sharedState.forkConfig.committeeBinding.activationHeight = 0
    peerlist = signers.map(s => s.identity)
    committee = await getBoundCommittee(9)
    committeeSigners = committee.map(id => signers.find(s => s.identity === id))
    outsiders = signers.filter(s => !committee.includes(s.identity))
})

describe("verifyBlock with real ed25519 signatures", () => {
    it("draws a committee of shardSize from a larger pool", () => {
        expect(committee).toHaveLength(4)
        expect(outsiders).toHaveLength(2)
    })

    it("accepts a quorum of committee signatures", async () => {
        const block = await signedBy(makeBlock("a"), committeeSigners.slice(0, 3))
        expect(await verifyBlock(block)).toEqual({ valid: true })
    })

    it("does not count a signature over another block's hash", async () => {
        const block = await signedBy(makeBlock("a"), committeeSigners.slice(0, 2))
        const other = makeBlock("b")
        block.validation_data.signatures[committeeSigners[2].identity] =
            await committeeSigners[2].sign(other.hash)

        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("2 of a bound committee of 4")
    })

    it("does not count a signature with a flipped byte", async () => {
        const block = await signedBy(makeBlock("a"), committeeSigners.slice(0, 3))
        const id = committeeSigners[2].identity
        const sig = block.validation_data.signatures[id] as string
        block.validation_data.signatures[id] =
            sig.slice(0, -2) + (sig.slice(-2) === "00" ? "01" : "00")

        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("2 of a bound committee of 4")
    })

    it("does not count a member's key under another member's identity", async () => {
        const block = await signedBy(makeBlock("a"), committeeSigners.slice(0, 2))
        block.validation_data.signatures[committeeSigners[2].identity] =
            await committeeSigners[3].sign(block.hash)

        expect((await verifyBlock(block)).valid).toBe(false)
    })

    it("does not count a valid signature by a pool member outside the committee", async () => {
        const block = await signedBy(makeBlock("a"), [
            ...committeeSigners.slice(0, 2),
            ...outsiders,
        ])

        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("2 of a bound committee of 4")
    })

    it("counts the same outside signatures before the fork", async () => {
        sharedState.forkConfig.committeeBinding.activationHeight = null
        const block = await signedBy(makeBlock("a"), [
            ...committeeSigners.slice(0, 2),
            outsiders[0],
        ])

        expect(await verifyBlock(block)).toEqual({ valid: true })
    })
})

describe("verifyBlock with the node's own pool signature", () => {
    it("counts a signature produced by TxValidatorPool.sign", async () => {
        sharedState.shardSize = 7
        peerlist = [...signers.map(s => s.identity), node.identity]
        resetPoolCache()
        const committee = await getBoundCommittee(9)
        expect(committee).toContain(node.identity)

        const others = signers.filter(s => committee.includes(s.identity)).slice(0, 4)
        const block = await signedBy(makeBlock("own"), [node, ...others])
        expect(await verifyBlock(block)).toEqual({ valid: true })

        delete block.validation_data.signatures[node.identity]
        expect((await verifyBlock(block)).valid).toBe(false)
    })
})

describe("two blocks at one height from disjoint signer groups", () => {
    // shardSize 10 needs 7; a pool of 14 holds two disjoint groups of 7.
    let groupA: Signer[] = []
    let groupB: Signer[] = []

    beforeEach(async () => {
        sharedState.shardSize = 10
        peerlist = allSigners.map(s => s.identity)
        resetPoolCache()
        const bound = await getBoundCommittee(9)
        const inCommittee = allSigners.filter(s => bound.includes(s.identity))
        const outside = allSigners.filter(s => !bound.includes(s.identity))
        groupA = inCommittee.slice(0, 7)
        groupB = [...inCommittee.slice(7), ...outside]
        expect(groupB).toHaveLength(7)
    })

    it("are both accepted before the fork", async () => {
        sharedState.forkConfig.committeeBinding.activationHeight = null
        const blockA = await signedBy(makeBlock("A"), groupA)
        const blockB = await signedBy(makeBlock("B"), groupB)

        expect(blockA.hash).not.toBe(blockB.hash)
        expect(await verifyBlock(blockA)).toEqual({ valid: true })
        expect(await verifyBlock(blockB)).toEqual({ valid: true })
    })

    it("are not both accepted under committeeBinding", async () => {
        const blockA = await signedBy(makeBlock("A"), groupA)
        const blockB = await signedBy(makeBlock("B"), groupB)

        expect(await verifyBlock(blockA)).toEqual({ valid: true })
        const verdictB = await verifyBlock(blockB)
        expect(verdictB.valid).toBe(false)
        expect(verdictB.reason).toContain("3 of a bound committee of 10 (need 7)")
    })
})

