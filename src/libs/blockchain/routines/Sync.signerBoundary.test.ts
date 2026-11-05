/**
 * A synced block is stored with the signatures its quorum counted and no
 * others (#990). Sync, the real verifier and real ed25519 signatures run
 * end to end; only the database, the GCR validator set and the state apply
 * are stubbed. What `Chain.insertBlock` receives is the row the node stores
 * and later serves to peers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import { type Signer, makeSigner } from "../../../../testing/consensus/committeeTestKit"

const NATIVE_HASHES = { native_subnets_txs: "subnets", native_tlsnotary: "tls" }
const realHashGCR = await import("../gcr/gcr_routines/hashGCR")
mock.module("../gcr/gcr_routines/hashGCR", () => ({
    ...realHashGCR,
    default: async () => ({ ...NATIVE_HASHES }),
}))

mock.module("src/utilities/logger", () => ({
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

const { default: chain } = await import("../chain")
const { default: handleGCR } = await import("../gcr/handleGCR")
const { default: gcr } = await import("../gcr/gcr")
const { default: datasource } = await import("@/model/datasource")
const { default: txValidatorPool } = await import("../validation/txValidatorPool")
const { getSharedState } = await import("@/utilities/sharedState")
const { serializeBlockContent } = await import("@/forks")
const { default: hashing } = await import("src/libs/crypto/hashing")
const { getNetworkTimestamp } = await import("src/libs/utils/calibrateTime")
const { __resetValidatorCache: resetPoolCache } = await import(
    "src/libs/consensus/v2/routines/getShard"
)
const verification = await import("../validation/verifyBlock")
const { syncBlock } = await import("./Sync")

const HEIGHT = 12
const PARENT_HASH = "parent-hash"
const upper = (id: string) => "0x" + id.slice(2).toUpperCase()
const clone = (value: unknown) => JSON.parse(JSON.stringify(value))

let members: Signer[] = []
let outsider: Signer
/** Addresses the GCR lists as the active validators at the parent. */
let validatorSet: string[] = []
let now = 0

const queryBuilder: any = {
    select: () => queryBuilder,
    addSelect: () => queryBuilder,
    where: () => queryBuilder,
    getRawOne: async () => ({ max: null }),
    getRawMany: async () => [],
}
const fakeDatasource = {
    getDataSource: () => ({
        getRepository: () => ({
            find: async () => [],
            createQueryBuilder: () => queryBuilder,
        }),
    }),
}

const PENDING = { write: async () => {}, afterCommit: async () => {} }
const insertBlock = spyOn(chain, "insertBlock")
const applyTransactions = spyOn(handleGCR, "applyTransactions")

/** An unsigned block on top of the stored parent, with its real content hash. */
function makeBlock(nonce = "a") {
    const content = {
        previousHash: PARENT_HASH,
        timestamp: now,
        ordered_transactions: [] as string[],
        peerlist: [] as string[],
        native_tables_hashes: NATIVE_HASHES,
        nonce,
    }
    return {
        number: HEIGHT,
        hash: hashing.sha256(serializeBlockContent(content as any, HEIGHT)),
        proposer: "forger",
        next_proposer: "forger",
        content,
        validation_data: { signatures: {} as Record<string, string> },
    } as any
}

async function sign(block: any, signer: Signer, key = signer.identity) {
    block.validation_data.signatures[key] = await signer.sign(block.hash)
    return block
}

async function signedBy(block: any, signers: Signer[]) {
    for (const signer of signers) await sign(block, signer)
    return block
}

const servingPeer = () =>
    ({
        identity: "peer-1",
        longCall: jest.fn(async () => ({ result: 200, response: [] })),
    }) as any

/** The block row the node stored, as a peer asking for it receives it. */
function served(): any {
    expect(insertBlock).toHaveBeenCalledTimes(1)
    return clone(insertBlock.mock.calls[0][0])
}

const storedSigners = () => Object.keys(served().validation_data.signatures).sort()

beforeAll(async () => {
    const signers = await Promise.all(
        Array.from({ length: 5 }, (_, i) => makeSigner(`signer-boundary-${i}`, i + 31)),
    )
    members = signers.slice(0, 4)
    outsider = signers[4]
    getSharedState.setShardSizeFromGenesis(4)
    // The pool's workers load the node identity, though they only verify here
    const state = getSharedState as any
    state.identity = { ...state.identity, masterSeed: new Uint8Array(128).fill(9) }
    await txValidatorPool.getInstance().start(1)
})

afterAll(async () => {
    await txValidatorPool.getInstance().stop()
})

const forkConfigAtStart = structuredClone(getSharedState.forkConfig)

beforeEach(() => {
    resetPoolCache()
    getSharedState.forkConfig = structuredClone(forkConfigAtStart)
    getSharedState.signingAlgorithm = "ed25519" as any
    getSharedState.lastBlockNumber = HEIGHT - 1
    getSharedState.fastSyncCount = 0
    getSharedState.referenceBlockRoom = 1
    now = getNetworkTimestamp()

    validatorSet = members.map(m => m.identity)
    spyOn(gcr, "getGCRValidatorsAtBlock").mockImplementation((async () =>
        validatorSet.map(address => ({ address }))) as any)
    // The parent commits no peerlist, so the pool is the staked set
    spyOn(chain, "getBlockByNumber").mockImplementation((async (n: number) =>
        n === HEIGHT - 1
            ? { number: n, hash: PARENT_HASH, content: { peerlist: [], timestamp: now - 100 } }
            : null) as any)
    spyOn(chain, "getLastBlockNumber").mockResolvedValue(HEIGHT - 1)
    spyOn(chain, "getExistingTransactionHashes").mockResolvedValue(new Set())
    spyOn(datasource, "getInstance").mockResolvedValue(fakeDatasource as any)

    applyTransactions.mockReset()
    applyTransactions.mockImplementation((async (
        _txs: unknown[],
        _isRollback: boolean,
        _clock: unknown,
        options?: { defer?: boolean },
    ) => ({
        successfulTxs: [],
        failedTxs: [],
        skippedTxs: [],
        pending: options?.defer ? PENDING : undefined,
    })) as any)
    insertBlock.mockReset()
    insertBlock.mockResolvedValue({} as any)
})

describe("sync stores only the signatures its quorum counted", () => {
    it("accepts a member quorum with an outsider's valid signature and stores it without the outsider", async () => {
        const block = await signedBy(makeBlock(), [...members.slice(0, 3), outsider])
        const sent = clone(block)

        expect(await syncBlock(block, servingPeer())).toBe(true)

        expect(storedSigners()).toEqual(members.slice(0, 3).map(m => m.identity).sort())
        // The caller's block is left as it was
        expect(block).toEqual(sent)
    })

    it("does not store a member key whose signature does not verify", async () => {
        const block = await signedBy(makeBlock(), members.slice(0, 3))
        block.validation_data.signatures[members[3].identity] = await members[3].sign("another hash")

        expect(await syncBlock(block, servingPeer())).toBe(true)

        expect(storedSigners()).toEqual(members.slice(0, 3).map(m => m.identity).sort())
    })

    it("keeps the rest of validation_data and stores the same block hash", async () => {
        const block = await signedBy(makeBlock(), [...members.slice(0, 3), outsider])
        block.validation_data.round = 3

        expect(await syncBlock(block, servingPeer())).toBe(true)

        const row = served()
        expect(row.hash).toBe(block.hash)
        expect(row.validation_data.round).toBe(3)
        expect(row.content).toEqual(block.content)
    })

    it("still rejects a block whose quorum needs the outsider", async () => {
        const block = await signedBy(makeBlock(), [...members.slice(0, 2), outsider])

        expect(await syncBlock(block, servingPeer())).toBe(false)
        expect(insertBlock).not.toHaveBeenCalled()
    })

    it("does not let an own __proto__ key of the served block set the stored block's prototype or attrs", async () => {
        const block = await signedBy(makeBlock(), members.slice(0, 3))
        const forged = "{\"__proto__\":{\"attrs\":{\"gcrAppliedTxCount\":999,\"gcrAppliedTxsHash\":\"forged\"}},"
        // JSON.parse keeps "__proto__" as an own property, as a peer's response does
        const wire = JSON.parse(forged + JSON.stringify(block).slice(1))
        expect(Object.keys(wire)).toContain("__proto__")

        expect(await syncBlock(wire, servingPeer())).toBe(true)

        expect(insertBlock).toHaveBeenCalledTimes(1)
        const stored = insertBlock.mock.calls[0][0] as any
        expect(Object.getPrototypeOf(stored)).toBe(Object.prototype)
        expect(stored.attrs).toBeUndefined()
        expect(storedSigners()).toEqual(members.slice(0, 3).map(m => m.identity).sort())
    })
})

describe("a stored block re-propagates without outsider signatures", () => {
    it("serves the block without the outsider, and it still verifies for the next node", async () => {
        const block = await signedBy(makeBlock(), [...members.slice(0, 3), outsider])
        expect(await syncBlock(block, servingPeer())).toBe(true)

        const row = served()
        expect(row.validation_data.signatures[outsider.identity]).toBeUndefined()
        expect(await verification.verifyBlock(row)).toEqual({ valid: true })

        // A second node syncing the served row stores the same certificate
        insertBlock.mockClear()
        expect(await syncBlock(clone(row), servingPeer())).toBe(true)
        expect(storedSigners()).toEqual(Object.keys(row.validation_data.signatures).sort())
    })
})

describe("signer identity case", () => {
    it("before canonicalSigners, a key in another case than its pool entry is neither counted nor stored", async () => {
        const block = await signedBy(makeBlock(), members.slice(0, 3))
        await sign(block, members[3], upper(members[3].identity))

        expect(await syncBlock(block, servingPeer())).toBe(true)
        expect(storedSigners()).toEqual(members.slice(0, 3).map(m => m.identity).sort())

        const short = await signedBy(makeBlock("b"), members.slice(0, 2))
        await sign(short, members[2], upper(members[2].identity))
        insertBlock.mockClear()
        expect(await syncBlock(short, servingPeer())).toBe(false)
    })

    describe("under canonicalSigners", () => {
        beforeEach(() => {
            const forks = getSharedState.forkConfig as any
            forks.canonicalSigners = { activationHeight: 0 }
        })

        it("counts and stores a member under its lowercase identity, whatever case the pool or the key uses", async () => {
            validatorSet = [upper(members[0].identity), ...members.slice(1).map(m => m.identity)]
            const block = await signedBy(makeBlock(), members.slice(1, 3))
            await sign(block, members[0], members[0].identity)
            await sign(block, members[3], upper(members[3].identity))

            expect(await syncBlock(block, servingPeer())).toBe(true)

            expect(storedSigners()).toEqual(members.map(m => m.identity).sort())
            // The stored keys are the ones the verifier counts
            expect(await verification.verifyBlock(served())).toEqual({ valid: true })
        })

        it("stores one entry for a member signing under two cases of its key", async () => {
            const block = await signedBy(makeBlock(), members.slice(0, 3))
            await sign(block, members[0], upper(members[0].identity))

            expect(await syncBlock(block, servingPeer())).toBe(true)

            expect(storedSigners()).toEqual(members.slice(0, 3).map(m => m.identity).sort())
        })

        it("does not let a key in two cases count twice towards the quorum", async () => {
            // The validator set lists one key twice, in two cases
            validatorSet = [...members.slice(0, 3).map(m => m.identity), upper(members[0].identity)]
            const block = await signedBy(makeBlock(), members.slice(0, 2))
            await sign(block, members[0], upper(members[0].identity))

            expect(await syncBlock(block, servingPeer())).toBe(false)
            expect(insertBlock).not.toHaveBeenCalled()
        })

        describe("with many cases of one member key", () => {
            /** `count` distinct spellings of `identity` that differ only in case. */
            function caseVariants(identity: string, count: number): string[] {
                const hex = identity.slice(2)
                const letters = [...hex].flatMap((c, i) => (/[a-f]/.test(c) ? [i] : []))
                const variants = new Set<string>()
                for (let mask = 1; variants.size < count; mask++) {
                    const chars = [...hex]
                    letters.forEach((at, bit) => {
                        if (mask & (1 << bit)) chars[at] = chars[at].toUpperCase()
                    })
                    variants.add("0x" + chars.join(""))
                }
                return [...variants]
            }

            async function floodedBlock(garbage = false) {
                const block = await signedBy(makeBlock(), members.slice(0, 3))
                for (const key of caseVariants(members[3].identity, 40)) {
                    await sign(block, members[3], key)
                    if (garbage) block.validation_data.signatures[key] = "00".repeat(64)
                }
                return block
            }

            it("verifies at most one signature per identity, so the work is bounded by the pool", async () => {
                const block = await floodedBlock()
                expect(Object.keys(block.validation_data.signatures).length).toBeGreaterThan(40)
                const verify = spyOn(txValidatorPool.getInstance(), "verify")

                const counted = await verification.countedSignatures(
                    block.hash,
                    block.validation_data.signatures,
                    new Set(members.map(m => m.identity)),
                    true,
                )

                expect(counted.size).toBe(4)
                expect(verify.mock.calls.length).toBeLessThanOrEqual(members.length)
                verify.mockRestore()
            })

            it("stores one entry for the flooded member and verifies a bounded number of times end to end", async () => {
                const block = await floodedBlock()
                const verify = spyOn(txValidatorPool.getInstance(), "verify")

                expect(await syncBlock(block, servingPeer())).toBe(true)

                expect(storedSigners()).toEqual(members.map(m => m.identity).sort())
                // verifyBlock and withCountedSignatures each count once
                expect(verify.mock.calls.length).toBeLessThanOrEqual(2 * members.length)
                verify.mockRestore()
            })

            it("counts only the first spelling in map order, even when it does not verify", async () => {
                const block = await floodedBlock(true)
                const verify = spyOn(txValidatorPool.getInstance(), "verify")
                // A valid signature under a later spelling is not tried
                await sign(block, members[3], upper(members[3].identity))

                const counted = await verification.countedSignatures(
                    block.hash,
                    block.validation_data.signatures,
                    new Set(members.map(m => m.identity)),
                    true,
                )

                expect([...counted.keys()].sort()).toEqual(members.slice(0, 3).map(m => m.identity).sort())
                expect(verify.mock.calls.length).toBeLessThanOrEqual(members.length)
                verify.mockRestore()
            })
        })

        it("counts a key in two cases once in the producer's commit check too", async () => {
            const { committeeCommitShortfall } = await import(
                "src/libs/consensus/v2/routines/committeeCommit"
            )
            const committee = [...members.slice(0, 3).map(m => m.identity), upper(members[0].identity)]
            const block = await signedBy(makeBlock(), members.slice(0, 2))
            await sign(block, members[0], upper(members[0].identity))

            expect(await committeeCommitShortfall(block, committee, 4)).toContain("carries 2 verified")
        })
    })
})

describe("withCountedSignatures", () => {
    it("returns a new block and leaves the caller's block and signature map untouched", async () => {
        const block = await signedBy(makeBlock(), [...members.slice(0, 3), outsider])
        const signatures = block.validation_data.signatures
        const sent = clone(block)

        const stored = await verification.withCountedSignatures(block)

        expect(stored).not.toBe(block)
        expect(stored.validation_data).not.toBe(block.validation_data)
        expect(block.validation_data.signatures).toBe(signatures)
        expect(block).toEqual(sent)
        expect(Object.keys(stored.validation_data.signatures)).toHaveLength(3)
    })

    it("fails closed when the signer set cannot be resolved", async () => {
        validatorSet = []
        process.env.DEMOS_REQUIRE_VALIDATORS = "true"
        try {
            const block = await signedBy(makeBlock(), members.slice(0, 3))
            await expect(verification.withCountedSignatures(block)).rejects.toThrow()
        } finally {
            delete process.env.DEMOS_REQUIRE_VALIDATORS
        }
    })

    it("fails closed on a block without a signature map", async () => {
        const block = makeBlock()
        delete block.validation_data.signatures
        await expect(verification.withCountedSignatures(block)).rejects.toThrow()
    })
})

describe("a second tally that falls below quorum", () => {
    it("does not store the block, so sync retries it", async () => {
        const block = await signedBy(makeBlock(), members.slice(0, 3))
        const pool = txValidatorPool.getInstance()
        const real = pool.verify.bind(pool)
        // The first quorum's worth of verifies (verifyBlock) succeed; the
        // next ones (the tally sync stores) fail as a validator worker timeout does
        let calls = 0
        const verify = spyOn(pool, "verify").mockImplementation((async (request: any) => {
            if (++calls > members.length - 1) throw new Error("validator request timed out")
            return real(request)
        }) as any)

        try {
            expect(await syncBlock(block, servingPeer())).toBe(false)
            expect(calls).toBeGreaterThan(members.length - 1)
            // Nothing was stored, so no block with fewer signatures than the quorum exists
            for (const [stored] of insertBlock.mock.calls) {
                expect(Object.keys(stored.validation_data.signatures).length).toBeGreaterThanOrEqual(3)
            }
            expect(insertBlock).not.toHaveBeenCalled()
        } finally {
            verify.mockRestore()
        }

        // With the validators answering again, the retry stores the full quorum
        expect(await syncBlock(clone(block), servingPeer())).toBe(true)
        expect(storedSigners()).toEqual(members.slice(0, 3).map(m => m.identity).sort())
    })
})
