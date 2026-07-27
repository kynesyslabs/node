import { verifyBlock } from "./verifyBlock"

const A = "aa".repeat(32)
const B = "bb".repeat(32)
const C = "cc".repeat(32)
const D = "dd".repeat(32)
const OUTSIDER = "ee".repeat(32)

let committee: string[] = []
let networkNow = 2000
let verifyingSigners: Set<string> = new Set()

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
        shardSize: 4,
        getBlockTimestampMinDelta: () => 1,
        getBlockTimestampTolerance: () => 60,
    },
}))

jest.mock("src/libs/utils/calibrateTime", () => ({
    getNetworkTimestamp: () => networkNow,
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

jest.mock(
    "src/libs/consensus/v2/routines/getCommonValidatorSeed",
    () => ({
        __esModule: true,
        default: async () => ({
            commonValidatorSeed: "cvsa-seed",
            lastBlockNumber: 9,
        }),
    }),
)

jest.mock("src/libs/consensus/v2/routines/getShard", () => ({
    __esModule: true,
    getShardIdentities: async () => committee,
    getCommitteeFloor: () => 3,
}))

jest.mock("./txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            verify: async ({ publicKey }: { publicKey: Uint8Array }) => {
                const hex = Buffer.from(publicKey).toString("hex")
                return verifyingSigners.has(hex)
            },
        }),
    },
}))

function makeBlock(overrides: Record<string, any> = {}) {
    return {
        number: 10,
        hash: "valid-hash",
        content: {
            previousHash: "hash-9",
            timestamp: 1500,
            ...(overrides.content ?? {}),
        },
        validation_data: overrides.validation_data ?? {
            signatures: { [A]: "s1", [B]: "s2", [C]: "s3" },
        },
        ...Object.fromEntries(
            Object.entries(overrides).filter(
                ([k]) => !["content", "validation_data"].includes(k),
            ),
        ),
    } as any
}

beforeEach(() => {
    committee = [A, B, C, D]
    networkNow = 2000
    verifyingSigners = new Set([A, B, C, D])
})

describe("verifyBlock", () => {
    it("accepts a block signed by 2/3+1 of its deterministic committee", async () => {
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(true)
    })

    it("does not count signatures from outside the committee", async () => {
        const block = makeBlock({
            validation_data: {
                signatures: { [A]: "s1", [B]: "s2", [OUTSIDER]: "s3" },
            },
        })
        verifyingSigners = new Set([A, B, OUTSIDER])
        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("insufficient verified committee")
    })

    it("rejects a back-dated block", async () => {
        const block = makeBlock({ content: { timestamp: 900 } })
        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("not after parent timestamp")
    })

    it("rejects a block equal to its parent's timestamp", async () => {
        const block = makeBlock({ content: { timestamp: 1000 } })
        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
    })

    it("rejects a future-dated block beyond tolerance", async () => {
        const block = makeBlock({ content: { timestamp: 2100 } })
        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("in the verifier's future")
    })

    it("accepts a block forged long after its parent", async () => {
        networkNow = 1000 + 3600
        const block = makeBlock({ content: { timestamp: 1000 + 3600 } })
        const result = await verifyBlock(block)
        expect(result.valid).toBe(true)
    })

    it("counts quorum against the committee size, not shardSize", async () => {
        committee = [A, B, C]
        const block = makeBlock({
            validation_data: {
                signatures: { [A]: "s1", [B]: "s2", [C]: "s3" },
            },
        })
        const result = await verifyBlock(block)
        expect(result.valid).toBe(true)
    })

    it("rejects when the committee is below the floor", async () => {
        committee = [A, B]
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("below the floor")
    })

    it("rejects when quorum is not met", async () => {
        const block = makeBlock({
            validation_data: { signatures: { [A]: "s1", [B]: "s2" } },
        })
        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
    })

    it("rejects a block whose hash does not match its content", async () => {
        const block = makeBlock({ hash: "tampered-hash" })
        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("hash mismatch")
    })

    it("accepts genesis without signatures", async () => {
        const result = await verifyBlock(makeBlock({ number: 0 }))
        expect(result.valid).toBe(true)
    })
})
