/**
 * Under commitLock the candidate carries a prevote bound to its height and
 * round, not a signature over the bare hash; the signing record is left to
 * the precommit. A rebuilt block that does not reproduce the hash it was
 * rebuilt for is refused before anything is signed.
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
    timestampCorrection: 0,
    forkConfig: {
        committeeBinding: { activationHeight: 0 },
        commitLock: { activationHeight: 0 },
    },
}
let contentHash = "hash-1"
const signed: string[] = []
const sign = jest.fn(async (_alg: string, message: Uint8Array) => {
    signed.push(new TextDecoder().decode(message))
    return { signature: new Uint8Array([1, 2, 3]) }
})

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
const { signingRecordPath, DoubleSignError, haltSigning, __resetSigningHalt } =
    await import("src/libs/identity/signingRecord")
const { CommitLockError } = await import("../commitLock/lockStore")
const roundState = await import("../commitLock/roundState")

const forge = (options: { round?: number; expectedHash?: string }) =>
    createBlock([{ hash: "t1" } as any], "seed", "prev", 5, ["p"], 1000, options)

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-createblock-lock-"))
    sharedState.identityFile = path.join(dir, ".demos_identity")
    sharedState.candidateBlock = null
    sharedState.forkConfig.commitLock.activationHeight = 0
    contentHash = "hash-1"
    signed.length = 0
    sign.mockClear()
    roundState.__resetRoundState()
    __resetSigningHalt()
})
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("createBlock under commitLock", () => {
    it("signs a prevote for the height and round and opens it", async () => {
        const block = await forge({ round: 7000 })
        expect(signed).toEqual(["demos-prevote:5:7000:hash-1"])
        expect(block.validation_data).toEqual({ signatures: { pub: "0x010203" }, round: 7000 })
        expect(roundState.openPrevote(5, 7000, "hash-1")?.inputs).toEqual({
            previousHash: "prev",
            orderedTransactions: ["t1"],
            peerlist: ["p"],
            timestamp: 1000,
        })
        // The record is the precommit's; a prevote leaves it untouched
        expect(fs.existsSync(signingRecordPath(sharedState.identityFile))).toBe(false)
    })

    it("refuses to sign without a round", async () => {
        await expect(forge({})).rejects.toBeInstanceOf(CommitLockError)
        expect(sign).not.toHaveBeenCalled()
        expect(sharedState.candidateBlock).toBeNull()
    })

    it("refuses a rebuild that does not reproduce its block, before signing", async () => {
        await expect(forge({ round: 7000, expectedHash: "hash-other" })).rejects.toBeInstanceOf(CommitLockError)
        expect(sign).not.toHaveBeenCalled()
        expect(roundState.latestPrevote()).toBeNull()
        await forge({ round: 7000, expectedHash: "hash-1" })
        expect(sign).toHaveBeenCalledTimes(1)
    })

    it("refuses a round far ahead of the clock before signing", async () => {
        const far = Math.floor(Date.now() / 1000) + 3600
        await expect(forge({ round: far })).rejects.toBeInstanceOf(CommitLockError)
        expect(sign).not.toHaveBeenCalled()
        expect(roundState.latestPrevote()).toBeNull()
        expect(sharedState.candidateBlock).toBeNull()

        // Within the lead an honest secretary's clock skew needs, it signs
        await forge({ round: Math.floor(Date.now() / 1000) + 2 })
        expect(sign).toHaveBeenCalledTimes(1)
    })

    it("does not prevote once signing is stopped", async () => {
        haltSigning("test")
        await expect(forge({ round: 7000 })).rejects.toBeInstanceOf(DoubleSignError)
        expect(sign).not.toHaveBeenCalled()
    })

    it("signs the bare hash and records it when the fork is dormant", async () => {
        sharedState.forkConfig.commitLock.activationHeight = null
        const block = await forge({ round: 7000 })
        expect(signed).toEqual(["hash-1"])
        expect(block.validation_data).toEqual({ signatures: { pub: "0x010203" } })
        expect(fs.existsSync(signingRecordPath(sharedState.identityFile))).toBe(true)
        expect(roundState.latestPrevote()).toBeNull()
    })
})
