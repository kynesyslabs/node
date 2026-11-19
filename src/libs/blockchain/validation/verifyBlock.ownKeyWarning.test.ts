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

// The real foreignSignature and signingRecord modules run here: the warning
// for our key's signature without a signing record can only be reached
// through verifyBlock, which checks our signature only when the block
// carries a verified one.

const A = "aa".repeat(32)
const B = "bb".repeat(32)
const C = "cc".repeat(32)
const D = "dd".repeat(32)
const GENESIS = "genesis-a"

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

jest.mock("src/utilities/sharedState", () => ({
    getSharedState: {
        signingAlgorithm: "ed25519",
        publicKeyHex: "aa".repeat(32),
        shardSize: 4,
        identityFile: "",
        genesisBlockHash: "genesis-a",
        forkConfig: {
            quorumParity: { activationHeight: null },
            committeeBinding: { activationHeight: null },
        },
        getBlockTimestampMinDelta: () => 1,
        getBlockTimestampTolerance: () => 60,
    },
}))

jest.mock("src/features/metrics/MetricsService", () => ({
    getMetricsService: () => ({ incrementCounter: jest.fn() }),
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
        getBlockByNumber: jest.fn(async (n: number) => ({
            number: n,
            hash: `hash-${n}`,
            content: { timestamp: 1000 },
        })),
    },
}))

jest.mock("src/libs/consensus/v2/routines/getShard", () => ({
    __esModule: true,
    getEligiblePool: async () => [
        "aa".repeat(32),
        "bb".repeat(32),
        "cc".repeat(32),
        "dd".repeat(32),
    ],
    getBoundCommittee: async () => [
        "aa".repeat(32),
        "bb".repeat(32),
        "cc".repeat(32),
        "dd".repeat(32),
    ],
}))

jest.mock("src/libs/debug/nonceTrace", () => ({
    __esModule: true,
    debugAssertionsEnabled: () => false,
}))

// Every signature in these blocks verifies; which keys signed is set by
// the block's validation_data.
jest.mock("./txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            verify: async () => true,
        }),
    },
}))

jest.mock("./verifyBlockTxSignatures", () => ({
    __esModule: true,
    verifyBlockTxSignatures: async () => ({ valid: true }),
}))

const warning = log.warning as jest.Mock
const sharedState = getSharedState as any

function makeBlock(signatures: Record<string, string>) {
    return {
        number: 10,
        hash: "valid-hash",
        proposer: A,
        next_proposer: B,
        status: "confirmed",
        content: {
            previousHash: "hash-9",
            timestamp: 1500,
        },
        validation_data: { signatures },
    } as any
}

let dir: string

beforeEach(() => {
    __resetSigningHalt()
    warning.mockClear()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-own-key-warning-"))
    sharedState.identityFile = path.join(dir, ".demos_identity")
    sharedState.genesisBlockHash = GENESIS
})

afterEach(() => {
    __resetSigningHalt()
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("verifyBlock own-key warning", () => {
    it("warns once when our key signed the block and no signing record exists", async () => {
        const result = await verifyBlock(
            makeBlock({ [A]: "s1", [B]: "s2", [C]: "s3" }),
        )

        expect(result.valid).toBe(true)
        expect(warning).toHaveBeenCalledTimes(1)
        expect(warning.mock.calls[0][0]).toContain("no signing record")
        expect(warning.mock.calls[0][0]).toContain("block 10")
    })

    it("does not warn when the signing record matches the block our key signed", async () => {
        recordBlockSignature(sharedState.identityFile, {
            genesisHash: GENESIS,
            height: 10,
            timestamp: 1500,
            hash: "valid-hash",
        })
        // Forget that this process signed it, so the block is judged
        // against the record on disk.
        __resetSigningHalt()
        warning.mockClear()

        const result = await verifyBlock(
            makeBlock({ [A]: "s1", [B]: "s2", [C]: "s3" }),
        )

        expect(result.valid).toBe(true)
        expect(warning).not.toHaveBeenCalled()
    })

    it("does not warn for a block without our signature", async () => {
        const result = await verifyBlock(
            makeBlock({ [B]: "s2", [C]: "s3", [D]: "s4" }),
        )

        expect(result.valid).toBe(true)
        expect(warning).not.toHaveBeenCalled()
    })
})
