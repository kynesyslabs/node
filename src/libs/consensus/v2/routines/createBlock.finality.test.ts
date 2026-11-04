/**
 * With `finalityProofs` inactive a forged block must hash exactly as it did
 * before the fork existed: same keys, same order, same bytes. Once active, the
 * commitments follow `native_tables_hashes` and nothing else moves.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let dir: string
const sharedState: any = {
    identityFile: "",
    genesisBlockHash: "genesis-a",
    candidateBlock: null,
    publicKeyHex: "pub",
    signingAlgorithm: "ed25519",
    getConsensusTime: () => 10,
    forkConfig: { finalityProofs: { activationHeight: null } },
}

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/libs/blockchain/gcr/gcr_routines/hashGCR", () => ({
    __esModule: true,
    default: async () => ({ native_gcr: "g", native_subnets_txs: "s" }),
}))
jest.mock("./getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "next" }),
}))
jest.mock("@/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            sign: async () => ({ signature: new Uint8Array([1, 2, 3]) }),
        }),
    },
}))
let parentBlock: any = null
let storedRows: any[] = []
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: async () => parentBlock,
        getTransactionsFromHashes: async (hashes: string[]) =>
            storedRows.filter(row => hashes.includes(row.hash)),
    },
}))
const SET_HASH = "5e".repeat(32)
jest.mock("src/libs/blockchain/finality/validatorSet", () => ({
    validatorSetAt: async (height: number) => ({
        block: height,
        setHash: SET_HASH,
        validators: [],
    }),
}))
jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => 1000,
}))

const { createBlock } = await import("./createBlock")
const { __resetCommitmentCache: resetCommitmentCache } = await import(
    "src/libs/blockchain/finality/commitments"
)
const { leafHash, toHex } = await import("src/libs/crypto/merkle/rfc6962")

// The bytes a block at height 5 hashed to before finalityProofs existed.
const PRE_FORK_CONTENT =
    "{\"ordered_transactions\":[\"t1\"],\"encrypted_transactions_hashes\":{}," +
    "\"per_address_transactions\":{},\"web2data\":{},\"previousHash\":\"prev\"," +
    "\"timestamp\":1000,\"peerlist\":[\"p1\"],\"l2ps_partecipating_nodes\":{}," +
    "\"l2ps_banned_nodes\":{},\"native_tables_hashes\":{\"native_gcr\":\"g\",\"native_subnets_txs\":\"s\"}}"

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

const forge = () =>
    createBlock([{ hash: "t1" } as any], "seed", "prev", 5, ["p1"], 1000)

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-finality-forge-"))
    sharedState.identityFile = path.join(dir, ".demos_identity")
    sharedState.candidateBlock = null
    sharedState.forkConfig.finalityProofs.activationHeight = null
    parentBlock = {
        number: 4,
        hash: "h4",
        content: { timestamp: 990, ordered_transactions: [] },
    }
    storedRows = []
    resetCommitmentCache()
})
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("forged block content under finalityProofs", () => {
    it("is byte-identical to the pre-fork content while the fork is inactive", async () => {
        const block = await forge()
        expect(JSON.stringify(block.content)).toBe(PRE_FORK_CONTENT)
        expect(block.hash).toBe(sha256(PRE_FORK_CONTENT))
    })

    it("stays byte-identical below the activation height", async () => {
        sharedState.forkConfig.finalityProofs.activationHeight = 6
        const block = await forge()
        expect(block.hash).toBe(sha256(PRE_FORK_CONTENT))
    })

    it("appends the commitments after native_tables_hashes, in their fixed order", async () => {
        sharedState.forkConfig.finalityProofs.activationHeight = 0
        parentBlock = {
            number: 4,
            hash: "h4",
            content: { timestamp: 990, ordered_transactions: ["x1"] },
        }
        storedRows = [
            { hash: "x1", status: "confirmed", attrs: {}, blockNumber: 4 },
        ]
        const leaf = new TextEncoder().encode(
            "{\"code\":null,\"hash\":\"x1\",\"status\":\"confirmed\"}",
        )
        const root = toHex(leafHash(leaf))

        const block = await forge()

        const expected =
            PRE_FORK_CONTENT.slice(0, -1) +
            `,"number":5,"parent_results_root":"${root}","validator_set_hash":"${SET_HASH}"}`
        expect(JSON.stringify(block.content)).toBe(expected)
        expect(block.hash).toBe(sha256(expected))
    })
})
