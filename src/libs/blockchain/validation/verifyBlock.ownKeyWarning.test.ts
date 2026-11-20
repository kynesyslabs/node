import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { verifyBlock } from "./verifyBlock"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import {
    __resetSigningHalt,
    recordBlockSignature,
} from "src/libs/identity/signingRecord"

const A = "aa".repeat(32)
const B = "bb".repeat(32)
const C = "cc".repeat(32)
const D = "dd".repeat(32)
const GENESIS = "genesis-a"
const mockPool = [A, B, C, D]
const warning = log.warning as jest.Mock
const sharedState = getSharedState as any

// The warning and signing-record modules stay real; only quorum dependencies are stubbed.
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { warning: jest.fn() },
}))
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: {},
}))
jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => 2000,
}))
jest.mock("@/forks", () => ({
    serializeBlockContent: () => "serialized-content",
}))
jest.mock("src/libs/crypto/hashing", () => ({
    __esModule: true,
    default: { sha256: () => "valid-hash" },
}))
jest.mock("../chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: jest
            .fn()
            .mockImplementation(number => ({
                number,
                hash: `hash-${number}`,
                content: { timestamp: 1000 },
            })),
    },
}))
jest.mock("src/libs/consensus/v2/routines/getShard", () => ({
    getEligiblePool: async () => mockPool,
    getBoundCommittee: async () => mockPool,
}))
jest.mock("src/libs/debug/nonceTrace", () => ({
    debugAssertionsEnabled: () => false,
}))
jest.mock("./txValidatorPool", () => ({
    __esModule: true,
    default: { getInstance: () => ({ verify: async () => true }) },
}))
jest.mock("./verifyBlockTxSignatures", () => ({
    verifyBlockTxSignatures: async () => ({ valid: true }),
}))

function signedBlock(signers: string[]) {
    return {
        number: 10,
        hash: "valid-hash",
        proposer: A,
        next_proposer: B,
        status: "confirmed",
        content: { previousHash: "hash-9", timestamp: 1500 },
        validation_data: {
            signatures: Object.fromEntries(signers.map(key => [key, "aa"])),
        },
    } as any
}

let directory: string

beforeEach(() => {
    __resetSigningHalt()
    warning.mockClear()
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "demos-own-key-warning-"))
    Object.assign(sharedState, {
        signingAlgorithm: "ed25519",
        publicKeyHex: A,
        shardSize: 4,
        identityFile: path.join(directory, ".demos_identity"),
        genesisBlockHash: GENESIS,
        forkConfig: {
            quorumParity: { activationHeight: null },
            committeeBinding: { activationHeight: null },
        },
        getBlockTimestampMinDelta: () => 1,
        getBlockTimestampTolerance: () => 60,
    })
})

afterEach(() => {
    __resetSigningHalt()
    fs.rmSync(directory, { recursive: true, force: true })
})

describe("verifyBlock own-key warning", () => {
    it("warns once when our key signed the block and no signing record exists", async () => {
        expect((await verifyBlock(signedBlock([A, B, C]))).valid).toBe(true)
        expect(warning).toHaveBeenCalledTimes(1)
        expect(warning.mock.calls[0][0]).toContain("no signing record")
        expect(warning.mock.calls[0][0]).toContain("block 10")
    })

    it("does not warn when the signing record matches the block our key signed", async () => {
        const block = signedBlock([A, B, C])
        recordBlockSignature(sharedState.identityFile, {
            genesisHash: GENESIS,
            height: 10,
            timestamp: 1500,
            hash: "valid-hash",
        })
        __resetSigningHalt()
        warning.mockClear()
        expect((await verifyBlock(block)).valid).toBe(true)
        expect(warning).not.toHaveBeenCalled()
    })

    it("does not warn for a block without our signature", async () => {
        expect((await verifyBlock(signedBlock([B, C, D]))).valid).toBe(true)
        expect(warning).not.toHaveBeenCalled()
    })
})
