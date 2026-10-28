/**
 * The candidate block is only signed after the signing record accepts its
 * round; a refused round leaves no signature and no candidate behind.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
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
}
let contentHash = "hash-1"
const sign = jest.fn(async () => ({ signature: new Uint8Array([1, 2, 3]) }))

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/libs/blockchain/block", () => ({
    __esModule: true,
    default: class {
        number: number | null = null
        hash: string | null = null
        content: any = { ordered_transactions: [], timestamp: null }
        validation_data: any = { signatures: {} }
        next_proposer = ""
    },
}))
jest.mock("src/libs/crypto/hashing", () => ({
    __esModule: true,
    default: { sha256: () => contentHash },
}))
jest.mock("src/libs/blockchain/gcr/gcr_routines/hashGCR", () => ({
    __esModule: true,
    default: async () => ({}),
}))
jest.mock("./getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "next" }),
}))
jest.mock("@/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: { getInstance: () => ({ sign }) },
}))
jest.mock("@/forks", () => ({ serializeBlockContent: () => "serialized" }))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getBlockByNumber: async () => null },
}))

const { createBlock } = await import("./createBlock")
const {
    DoubleSignError,
    SigningRecordError,
    loadSigningRecord,
    signingRecordPath,
} = await import("src/libs/identity/signingRecord")

const forge = (height: number, timestamp: number) =>
    createBlock([], "seed", "prev", height, [], timestamp)

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-createblock-"))
    sharedState.identityFile = path.join(dir, ".demos_identity")
    sharedState.candidateBlock = null
    sharedState.genesisBlockHash = "genesis-a"
    contentHash = "hash-1"
    sign.mockReset()
    sign.mockImplementation(async () => ({
        signature: new Uint8Array([1, 2, 3]),
    }))
})
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("createBlock signing guard", () => {
    it("records the round and signs the first block", async () => {
        const block = await forge(5, 1000)
        expect(sign).toHaveBeenCalledTimes(1)
        expect(block.validation_data.signatures.pub).toBe("0x010203")
        expect(loadSigningRecord(sharedState.identityFile)).toMatchObject({
            genesisHash: "genesis-a",
            height: 5,
            timestamp: 1000,
            hash: "hash-1",
        })
    })

    it("does not sign a different block for the same round", async () => {
        await forge(5, 1000)
        sign.mockClear()
        sharedState.candidateBlock = null
        contentHash = "hash-2"
        await expect(forge(5, 1000)).rejects.toBeInstanceOf(DoubleSignError)
        expect(sign).not.toHaveBeenCalled()
        expect(sharedState.candidateBlock).toBeNull()
    })

    it("signs a retry of the same height with a later timestamp", async () => {
        await forge(5, 1000)
        sharedState.candidateBlock = null
        contentHash = "hash-2"
        await forge(5, 1010)
        expect(sign).toHaveBeenCalledTimes(2)
    })

    it("writes no record when signing fails", async () => {
        sign.mockRejectedValueOnce(new Error("pool down"))
        await expect(forge(5, 1000)).rejects.toThrow("pool down")
        expect(fs.existsSync(signingRecordPath(sharedState.identityFile))).toBe(
            false,
        )
        expect(sharedState.candidateBlock).toBeNull()
        // The same round can still be signed afterwards.
        await forge(5, 1000)
        expect(sign).toHaveBeenCalledTimes(2)
    })

    it("returns no signed block when the record cannot be persisted", async () => {
        sharedState.identityFile = path.join(dir, "gone", ".demos_identity")
        await expect(forge(5, 1000)).rejects.toBeInstanceOf(SigningRecordError)
        expect(sharedState.candidateBlock).toBeNull()
    })

    it("refuses to sign before the genesis hash is known", async () => {
        sharedState.genesisBlockHash = null
        await expect(forge(5, 1000)).rejects.toBeInstanceOf(SigningRecordError)
        expect(sign).not.toHaveBeenCalled()
    })

    it("signs again after a chain reset instead of staying blocked", async () => {
        await forge(500, 9000)
        sharedState.candidateBlock = null
        sharedState.genesisBlockHash = "genesis-b"
        contentHash = "hash-2"
        await forge(1, 100)
        expect(loadSigningRecord(sharedState.identityFile)).toMatchObject({
            genesisHash: "genesis-b",
            height: 1,
        })
    })

    it("in production, refuses a record of another chain without signing", async () => {
        await forge(500, 9000)
        sharedState.candidateBlock = null
        sharedState.genesisBlockHash = "genesis-b"
        sharedState.PROD = true
        sign.mockClear()
        try {
            await expect(forge(1, 100)).rejects.toBeInstanceOf(DoubleSignError)
        } finally {
            sharedState.PROD = undefined
        }
        expect(sign).not.toHaveBeenCalled()
        expect(loadSigningRecord(sharedState.identityFile)?.genesisHash).toBe(
            "genesis-a",
        )
    })
})
