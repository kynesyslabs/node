/**
 * The producer's pre-commit check under committeeBinding, with real ed25519
 * signatures verified through a started TxValidatorPool. A producer must
 * commit exactly the blocks that syncing nodes accept, so the check is
 * compared with verifyBlock on every signer subset of a small pool.
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
jest.mock("src/libs/blockchain/validation/verifyBlockTxSignatures", () => ({
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

const { verifyBlock } = await import("src/libs/blockchain/validation/verifyBlock")
const { committeeCommitShortfall } = await import("./committeeCommit")
const { getBoundCommittee, __resetValidatorCache: resetPoolCache } = await import("./getShard")
const validatorPool = (
    await import("src/libs/blockchain/validation/txValidatorPool")
).default.getInstance()
const sha256 = (await import("src/libs/crypto/hashing")).default.sha256

interface Signer {
    identity: string
    sign: (message: string) => Promise<string>
}

async function makeSigner(index: number): Promise<Signer> {
    const seed = new Uint8Array(128).fill(index + 1)
    const crypto = getUnifiedCryptoInstance(`commit-test-${index}`, seed)
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

beforeAll(async () => {
    signers = await Promise.all(Array.from({ length: 6 }, (_, i) => makeSigner(i)))
    await validatorPool.start(1)
})

afterAll(async () => {
    await validatorPool.stop()
})

beforeEach(async () => {
    resetPoolCache()
    peerlist = signers.map(s => s.identity)
    committee = await getBoundCommittee(9)
    committeeSigners = committee.map(id => signers.find(s => s.identity === id))
    outsiders = signers.filter(s => !committee.includes(s.identity))
})

describe("committeeCommitShortfall", () => {
    it("allows a commit carrying a quorum of committee signatures", async () => {
        const block = await signedBy(makeBlock("a"), committeeSigners.slice(0, 3))
        expect(await committeeCommitShortfall(block, committee, 4)).toBeNull()
    })

    it("refuses a commit whose pro votes came from outside the committee", async () => {
        const block = await signedBy(makeBlock("a"), [...committeeSigners.slice(0, 2), ...outsiders])
        expect(await committeeCommitShortfall(block, committee, 4)).toBe(
            "block 10 carries 2 verified signatures of its bound committee of 4, below the 3 sync requires",
        )
    })

    it("does not count a committee signature over another hash", async () => {
        const block = await signedBy(makeBlock("a"), committeeSigners.slice(0, 2))
        block.validation_data.signatures[committeeSigners[2].identity] =
            await committeeSigners[2].sign(makeBlock("b").hash)
        expect(await committeeCommitShortfall(block, committee, 4)).toContain("carries 2 verified")
    })

    it("refuses a block without validation data", async () => {
        const block = makeBlock("a")
        delete block.validation_data
        expect(await committeeCommitShortfall(block, committee, 4)).toContain("carries 0 verified")
    })

    it("agrees with verifyBlock on every subset of signers", async () => {
        for (let mask = 0; mask < 1 << signers.length; mask++) {
            const subset = signers.filter((_, i) => mask & (1 << i))
            const block = await signedBy(makeBlock(`m${mask}`), subset)
            const commits = (await committeeCommitShortfall(block, committee, 4)) === null
            const accepted = (await verifyBlock(block)).valid
            expect({ mask, commits }).toEqual({ mask, commits: accepted })
        }
    })
})
