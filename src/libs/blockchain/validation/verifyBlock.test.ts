import {
    checkTimestampAgainstParent,
    checkTimestampNotAhead,
    verifyBlock,
    verifyBlockCertificate,
} from "./verifyBlock"
import { getSharedState } from "src/utilities/sharedState"

const A = "aa".repeat(32)
const B = "bb".repeat(32)
const C = "cc".repeat(32)
const D = "dd".repeat(32)
const OUTSIDER = "ee".repeat(32)
// A signature that does not verify under any key
const FORGED = "0bad"

let pool: string[] | Error = []
let committee: string[] | Error = []
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
        publicKeyHex: "aa".repeat(32),
        shardSize: 4,
        forkConfig: {
            quorumParity: { activationHeight: null },
            committeeBinding: { activationHeight: null },
            canonicalSigners: { activationHeight: null },
        },
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

jest.mock("src/libs/consensus/v2/routines/getShard", () => ({
    __esModule: true,
    getEligiblePool: async () => {
        if (pool instanceof Error) throw pool
        return pool
    },
    getBoundCommittee: async () => {
        if (committee instanceof Error) throw committee
        return committee
    },
}))

jest.mock("src/libs/debug/nonceTrace", () => ({
    __esModule: true,
    debugAssertionsEnabled: () => false,
}))

jest.mock("./txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            verify: async ({
                publicKey,
                signature,
            }: {
                publicKey: Uint8Array
                signature: Uint8Array
            }) => {
                if (Buffer.from(signature).toString("hex") === FORGED) {
                    return false
                }
                const hex = Buffer.from(publicKey).toString("hex")
                return verifyingSigners.has(hex)
            },
        }),
    },
}))

// The per-transaction re-check has its own suite; here only its wiring into
// verifyBlock matters, and the real module pulls the ESM-only SDK crypto.
const verifyBlockTxSignatures = jest.fn(
    async (): Promise<{ valid: boolean; reason?: string }> => ({ valid: true }),
)
jest.mock("./verifyBlockTxSignatures", () => ({
    __esModule: true,
    verifyBlockTxSignatures: (...args: unknown[]) =>
        (verifyBlockTxSignatures as any)(...args),
}))

const checkOwnSignature = jest.fn()
jest.mock("src/libs/identity/foreignSignature", () => ({
    __esModule: true,
    checkOwnSignature: (...args: unknown[]) =>
        (checkOwnSignature as any)(...args),
}))

function makeBlock(overrides: Record<string, any> = {}) {
    return {
        number: 10,
        hash: "valid-hash",
        proposer: A,
        next_proposer: B,
        status: "confirmed",
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
    checkOwnSignature.mockClear()
    verifyBlockTxSignatures.mockClear()
    verifyBlockTxSignatures.mockImplementation(async () => ({ valid: true }))
    pool = [A, B, C, D]
    networkNow = 2000
    verifyingSigners = new Set([A, B, C, D])
    getSharedState.forkConfig.quorumParity.activationHeight = null
    getSharedState.forkConfig.committeeBinding.activationHeight = null
    getSharedState.forkConfig.canonicalSigners.activationHeight = null
    committee = [A, B, C, D]
})

describe("verifyBlock", () => {
    it("accepts a block signed by 2/3+1 of the eligible pool", async () => {
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(true)
    })

    it("does not count signatures from outside the pool", async () => {
        const block = makeBlock({
            validation_data: {
                signatures: { [A]: "s1", [B]: "s2", [OUTSIDER]: "s3" },
            },
        })
        verifyingSigners = new Set([A, B, OUTSIDER])
        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("insufficient verified pool")
    })

    it("rejects the block with the original reason when the pool cannot be resolved", async () => {
        pool = new Error("block 9 not found")
        const result = await verifyBlock(makeBlock())
        expect(result).toEqual({
            valid: false,
            reason: "could not resolve eligible signer pool: block 9 not found",
        })
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

    it("pre-fork: counts quorum against min(shardSize, pool size)", async () => {
        pool = [A, B, C]
        const block = makeBlock({
            validation_data: {
                signatures: { [A]: "s1", [B]: "s2", [C]: "s3" },
            },
        })
        const result = await verifyBlock(block)
        expect(result.valid).toBe(true)
    })

    it("pre-fork: accepts a small network reaching quorum of its pool", async () => {
        pool = [A, B]
        const block = makeBlock({
            validation_data: { signatures: { [A]: "s1", [B]: "s2" } },
        })
        const result = await verifyBlock(block)
        expect(result.valid).toBe(true)
    })

    it("rejects when the eligible pool is empty", async () => {
        pool = []
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("eligible signer pool is empty")
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

    // Outside the hash, so only this check stands between them and the
    // block insert, which Postgres would fail on every node that took it.
    for (const [column, value] of [
        ["proposer", A + "\u0000"],
        ["next_proposer", "\u0000"],
        ["proposer", A + "\ud800"],
        ["status", "confirmed\u0000"],
        ["proposer", [A + "\u0000"]],
        ["next_proposer", null],
    ] as const) {
        it(`rejects a served block whose ${column} Postgres cannot store: ${JSON.stringify(value)}`, async () => {
            const result = await verifyBlock(makeBlock({ [column]: value }))
            expect(result.valid).toBe(false)
            expect(result.reason).toContain(`Block ${column}`)
        })
    }

    it("rejects a block carrying finality commitments before the fork", async () => {
        const block = makeBlock({ content: { number: 10 } })
        const result = await verifyBlock(block)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("before finalityProofs")
    })

    it("accepts genesis without signatures", async () => {
        const result = await verifyBlock(makeBlock({ number: 0 }))
        expect(result.valid).toBe(true)
    })

    it("does not re-check transactions when none are supplied", async () => {
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(true)
        expect(verifyBlockTxSignatures).not.toHaveBeenCalled()
    })

    it("re-checks supplied transactions once the quorum holds", async () => {
        const block = makeBlock()
        const txs = [{ hash: "tx-1" }] as any
        const result = await verifyBlock(block, txs)
        expect(result.valid).toBe(true)
        expect(verifyBlockTxSignatures).toHaveBeenCalledTimes(1)
        expect(verifyBlockTxSignatures).toHaveBeenCalledWith(block, txs)
    })

    it("re-checks an empty transaction list", async () => {
        const block = makeBlock()
        await verifyBlock(block, [])
        expect(verifyBlockTxSignatures).toHaveBeenCalledWith(block, [])
    })

    it("rejects the block when a transaction signature fails", async () => {
        verifyBlockTxSignatures.mockImplementation(async () => ({
            valid: false,
            reason: "tx tx-1: bad signature",
        }))
        const result = await verifyBlock(makeBlock(), [{ hash: "tx-1" }] as any)
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("bad signature")
    })

    it("skips the transaction re-check when the quorum fails", async () => {
        const block = makeBlock({
            validation_data: { signatures: { [A]: "s1", [B]: "s2" } },
        })
        const result = await verifyBlock(block, [{ hash: "tx-1" }] as any)
        expect(result.valid).toBe(false)
        expect(verifyBlockTxSignatures).not.toHaveBeenCalled()
    })

    describe("own-key self-check", () => {
        it("checks an accepted block that carries our verified signature", async () => {
            await verifyBlock(makeBlock())
            expect(checkOwnSignature).toHaveBeenCalledWith({
                number: 10,
                hash: "valid-hash",
                timestamp: 1500,
            })
        })

        it("skips blocks without our signature", async () => {
            const block = makeBlock({
                validation_data: {
                    signatures: { [B]: "s2", [C]: "s3", [D]: "s4" },
                },
            })
            expect((await verifyBlock(block)).valid).toBe(true)
            expect(checkOwnSignature).not.toHaveBeenCalled()
        })

        it("skips our signature when it does not verify", async () => {
            verifyingSigners = new Set([B, C, D])
            const block = makeBlock({
                validation_data: {
                    signatures: { [A]: "s1", [B]: "s2", [C]: "s3", [D]: "s4" },
                },
            })
            expect((await verifyBlock(block)).valid).toBe(true)
            expect(checkOwnSignature).not.toHaveBeenCalled()
        })

        it("skips a block without quorum", async () => {
            const block = makeBlock({
                validation_data: { signatures: { [A]: "s1", [B]: "s2" } },
            })
            expect((await verifyBlock(block)).valid).toBe(false)
            expect(checkOwnSignature).not.toHaveBeenCalled()
        })
    })

    describe("own-key self-check under canonicalSigners", () => {
        const ownCheck = { number: 10, hash: "valid-hash", timestamp: 1500 }
        const signed = (signatures: Record<string, string>) =>
            makeBlock({ validation_data: { signatures } })

        beforeEach(() => {
            getSharedState.forkConfig.canonicalSigners.activationHeight = 0
        })

        it("checks our key written upper-case when it supplies the quorum", async () => {
            const block = signed({ [A.toUpperCase()]: "s1", [B]: "s2", [C]: "s3" })
            expect((await verifyBlock(block)).valid).toBe(true)
            expect(checkOwnSignature).toHaveBeenCalledWith(ownCheck)
        })

        it("checks the other spelling when the exact key's signature does not verify", async () => {
            const block = signed({
                [A]: FORGED,
                [A.toUpperCase()]: "s1",
                [B]: "s2",
                [C]: "s3",
                [D]: "s4",
            })
            expect((await verifyBlock(block)).valid).toBe(true)
            expect(checkOwnSignature).toHaveBeenCalledWith(ownCheck)
        })

        it("checks the exact key when the other spelling's signature does not verify", async () => {
            const block = signed({
                [A.toUpperCase()]: FORGED,
                [A]: "s1",
                [B]: "s2",
                [C]: "s3",
                [D]: "s4",
            })
            expect((await verifyBlock(block)).valid).toBe(true)
            expect(checkOwnSignature).toHaveBeenCalledWith(ownCheck)
        })

        it("checks a block once when both spellings verify", async () => {
            const block = signed({
                [A]: "s1",
                [A.toUpperCase()]: "s1",
                [B]: "s2",
                [C]: "s3",
            })
            expect((await verifyBlock(block)).valid).toBe(true)
            expect(checkOwnSignature).toHaveBeenCalledTimes(1)
        })

        it("skips every spelling of our key whose signature does not verify", async () => {
            const block = signed({
                [A]: FORGED,
                [A.toUpperCase()]: FORGED,
                [B]: "s2",
                [C]: "s3",
                [D]: "s4",
            })
            expect((await verifyBlock(block)).valid).toBe(true)
            expect(checkOwnSignature).not.toHaveBeenCalled()
        })

        it("looks only at the exact key while the fork is dormant", async () => {
            getSharedState.forkConfig.canonicalSigners.activationHeight = null
            const block = signed({
                [A.toUpperCase()]: "s1",
                [B]: "s2",
                [C]: "s3",
                [D]: "s4",
            })
            expect((await verifyBlock(block)).valid).toBe(true)
            expect(checkOwnSignature).not.toHaveBeenCalled()

            delete block.validation_data.signatures[D]
            expect((await verifyBlock(block)).valid).toBe(false)
            expect(checkOwnSignature).not.toHaveBeenCalled()
        })

        it("accepts a block before our keypair is loaded", async () => {
            const state = getSharedState as { publicKeyHex: string | null }
            state.publicKeyHex = null
            try {
                const block = signed({ [A]: "s1", [B]: "s2", [C]: "s3" })
                expect((await verifyBlock(block)).valid).toBe(true)
                expect(checkOwnSignature).not.toHaveBeenCalled()
            } finally {
                state.publicKeyHex = A
            }
        })

        it("looks only at blocks from the activation height on", async () => {
            getSharedState.forkConfig.canonicalSigners.activationHeight = 11
            const block = signed({
                [A.toUpperCase()]: "s1",
                [B]: "s2",
                [C]: "s3",
                [D]: "s4",
            })
            expect((await verifyBlock(block)).valid).toBe(true)
            expect(checkOwnSignature).not.toHaveBeenCalled()
        })
    })
})

describe("verifyBlock under quorumParity", () => {
    const twoOfTwo = () =>
        makeBlock({ validation_data: { signatures: { [A]: "s1", [B]: "s2" } } })

    it("rejects two signatures from a pool of two at shardSize 4", async () => {
        getSharedState.forkConfig.quorumParity.activationHeight = 0
        pool = [A, B]
        const result = await verifyBlock(twoOfTwo())
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("need 3")
    })

    it("accepts three signatures, the producer's bar at shardSize 4", async () => {
        getSharedState.forkConfig.quorumParity.activationHeight = 0
        pool = [A, B, C]
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(true)
    })

    it("keeps the pool-relative rule below the activation height", async () => {
        getSharedState.forkConfig.quorumParity.activationHeight = 11
        pool = [A, B]
        const result = await verifyBlock(twoOfTwo())
        expect(result.valid).toBe(true)
    })

    it("applies from the activation height itself", async () => {
        getSharedState.forkConfig.quorumParity.activationHeight = 10
        pool = [A, B]
        const result = await verifyBlock(twoOfTwo())
        expect(result.valid).toBe(false)
    })
})

describe("verifyBlock under committeeBinding", () => {
    beforeEach(() => {
        getSharedState.forkConfig.committeeBinding.activationHeight = 0
    })

    it("accepts 2/3 + 1 of shardSize signed by bound committee members", async () => {
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(true)
    })

    it("does not count a pool member outside the bound committee", async () => {
        pool = [A, B, C, D]
        committee = [A, B, D]
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(false)
        expect(result.reason).toContain(
            "insufficient verified committee signatures: 2 of a bound committee of 3 (need 3)",
        )
    })

    it("keeps the bar at shardSize when the committee is smaller", async () => {
        committee = [A, B]
        const result = await verifyBlock(
            makeBlock({ validation_data: { signatures: { [A]: "s1", [B]: "s2" } } }),
        )
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("need 3")
    })

    it("rejects the block when the committee cannot be resolved", async () => {
        committee = new Error("block 9 not found")
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(false)
        expect(result.reason).toBe("could not resolve bound committee: block 9 not found")
    })

    it("rejects the block when the committee is empty", async () => {
        committee = []
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(false)
        expect(result.reason).toBe("bound committee is empty")
    })

    it("counts pool signers below the activation height", async () => {
        getSharedState.forkConfig.committeeBinding.activationHeight = 11
        committee = [A, B, D]
        const result = await verifyBlock(makeBlock())
        expect(result.valid).toBe(true)
    })
})

describe("whole-second block timestamps", () => {
    const fractional = () => makeBlock({ content: { timestamp: 1500.5 } })

    it("accepts a fractional timestamp before committeeBinding", async () => {
        const result = await verifyBlock(fractional())
        expect(result.valid).toBe(true)
    })

    it("rejects a fractional timestamp under committeeBinding", async () => {
        getSharedState.forkConfig.committeeBinding.activationHeight = 0
        const result = await verifyBlock(fractional())
        expect(result).toEqual({
            valid: false,
            reason: "block timestamp 1500.5 is not a whole number of seconds",
        })
    })

    it("applies from the activation height itself, not below it", async () => {
        getSharedState.forkConfig.committeeBinding.activationHeight = 11
        expect((await verifyBlock(fractional())).valid).toBe(true)
        getSharedState.forkConfig.committeeBinding.activationHeight = 10
        expect((await verifyBlock(fractional())).valid).toBe(false)
    })

    it("is part of the parent check the proposeBlockHash handler shares", () => {
        getSharedState.forkConfig.committeeBinding.activationHeight = 0
        expect(checkTimestampAgainstParent(1500.5, 1000, 10).valid).toBe(false)
        expect(checkTimestampAgainstParent(1500, 1000, 10).valid).toBe(true)
        getSharedState.forkConfig.committeeBinding.activationHeight = null
        expect(checkTimestampAgainstParent(1500.5, 1000, 10).valid).toBe(true)
    })
})

describe("checkTimestampNotAhead", () => {
    it("accepts a timestamp up to the tolerance ahead of the given clock", () => {
        expect(checkTimestampNotAhead(5060, 5000).valid).toBe(true)
        expect(checkTimestampNotAhead(4000, 5000).valid).toBe(true)
    })

    it("rejects a timestamp past the tolerance", () => {
        const verdict = checkTimestampNotAhead(5061, 5000)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("61s in the verifier's future (tolerance 60s)")
    })

    it("reads this node's clock when no time is given", () => {
        networkNow = 7000
        expect(checkTimestampNotAhead(7060).valid).toBe(true)
        expect(checkTimestampNotAhead(7061).valid).toBe(false)
    })
})

describe("verifyBlockCertificate", () => {
    it("accepts a quorum-signed block whatever parent it names", async () => {
        const block = makeBlock({ content: { previousHash: "not-our-chain" } })
        expect((await verifyBlockCertificate(block)).valid).toBe(true)
    })

    it("rejects a block whose hash does not match its content", async () => {
        const result = await verifyBlockCertificate(makeBlock({ hash: "tampered-hash" }))
        expect(result.valid).toBe(false)
        expect(result.reason).toContain("hash mismatch")
    })

    it("rejects a block without the quorum, and a malformed one without throwing", async () => {
        const unsigned = makeBlock({ validation_data: { signatures: { [A]: "s1" } } })
        expect((await verifyBlockCertificate(unsigned)).valid).toBe(false)
        expect((await verifyBlockCertificate({ number: 10, hash: "x" } as any)).valid).toBe(false)
    })
})
