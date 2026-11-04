/**
 * Block N commits its height, the result root of block N - 1 and the hash of
 * the validator set after it. Every member derives them from its own
 * committed rows and votes only on an identical hash, so the leaf encoding,
 * the order and every edge (genesis parent, empty block, a transaction
 * already on chain, a missing snapshot) must be fixed.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { createHash } from "node:crypto"

interface Row {
    hash: string
    status: string
    attrs: Record<string, unknown> | null
    blockNumber: number
}

let blocks = new Map<number, any>()
let rows = new Map<string, Row>()
const getTransactionsFromHashes = jest.fn(async (hashes: string[]) =>
    hashes.filter(h => rows.has(h)).map(h => ({ ...rows.get(h) })),
)

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getBlockByNumber: async (n: number) => blocks.get(n) ?? null,
        getTransactionsFromHashes,
    },
}))

/** Snapshot hash per height a set was recorded at. */
let setHashes = new Map<number, string>()
const validatorSetAt = jest.fn(async (height: number) => {
    const at = [...setHashes.keys()].filter(b => b <= height).sort((x, y) => y - x)[0]
    return at === undefined
        ? null
        : { block: at, setHash: setHashes.get(at), validators: [] }
})
const realValidatorSet = await import("./validatorSet")
mock.module("./validatorSet", () => ({ ...realValidatorSet, validatorSetAt }))

const { getSharedState } = await import("@/utilities/sharedState")
const { cloneDefaultForkConfig } = await import("@/forks/forkConfig")
const { EMPTY_ROOT, leafHash, nodeHash, root, toHex } = await import(
    "src/libs/crypto/merkle/rfc6962"
)
const {
    EMPTY_RESULTS_ROOT,
    buildCommitments,
    parentResultsRoot,
    projectedResultsRoot,
    resultLeaf,
    resultsRoot,
    verifyCommitments,
} = await import("./commitments")
const {
    FinalityCommitmentError: commitmentError,
    __resetCommitmentCache: resetCommitmentCache,
} = await import("./commitments")

const H = (n: number) => n.toString(16).padStart(64, "0")
const SET_0 = "5e".repeat(32)
const SET_3 = "3e".repeat(32)
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const confirmed = (hash: string, blockNumber: number): Row => ({
    hash,
    status: "confirmed",
    attrs: { reference_block: blockNumber - 1 },
    blockNumber,
})
const failed = (hash: string, blockNumber: number, code: unknown): Row => ({
    hash,
    status: "failed",
    attrs: { code, message: "anything", reference_block: blockNumber - 1 },
    blockNumber,
})

function parent(number: number, ordered: string[]) {
    return { number, hash: `parent-${number}-${ordered.join(".")}`, content: { ordered_transactions: ordered } }
}

function storeParent(number: number, ordered: string[], stored: Row[]) {
    const block = parent(number, ordered)
    blocks.set(number, block)
    for (const row of stored) rows.set(row.hash, row)
    return block
}

/** Content as createBlock lays it out, commitments last. */
function content(extra: Record<string, unknown> = {}) {
    return {
        ordered_transactions: [],
        previousHash: "prev",
        timestamp: 1,
        peerlist: [],
        native_tables_hashes: { native_gcr: "g" },
        ...extra,
    }
}

let savedForks: any

beforeEach(() => {
    savedForks = getSharedState.forkConfig
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.finalityProofs.activationHeight = 0
    blocks = new Map()
    rows = new Map()
    getTransactionsFromHashes.mockClear()
    setHashes = new Map([[0, SET_0]])
    validatorSetAt.mockClear()
    resetCommitmentCache()
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
})

describe("result leaf", () => {
    it("is jcs of code, hash and status, the message left out", () => {
        expect(text(resultLeaf(confirmed(H(1), 7), 7))).toBe(
            `{"code":null,"hash":"${H(1)}","status":"confirmed"}`,
        )
        expect(text(resultLeaf(failed(H(2), 7, "TX_EXECUTE_FAILED"), 7))).toBe(
            `{"code":"TX_EXECUTE_FAILED","hash":"${H(2)}","status":"failed"}`,
        )
    })

    it("carries no code that is not a string", () => {
        for (const code of [7, { nested: 1 }, true, undefined]) {
            expect(text(resultLeaf(failed(H(3), 7, code), 7))).toBe(
                `{"code":null,"hash":"${H(3)}","status":"failed"}`,
            )
        }
    })

    it("carries no code on a confirmed row, whatever its attrs say", () => {
        const row = { ...confirmed(H(5), 7), attrs: { code: "X" } }
        expect(text(resultLeaf(row, 7))).toBe(
            `{"code":null,"hash":"${H(5)}","status":"confirmed"}`,
        )
    })

    it("reads a row stored with an earlier block as not executed in this one", () => {
        expect(text(resultLeaf(confirmed(H(4), 3), 7))).toBe(
            `{"code":"TX_EXISTS","hash":"${H(4)}","status":"failed"}`,
        )
    })

    it("refuses a row that has no final status", () => {
        expect(() => resultLeaf({ ...confirmed(H(5), 7), status: "pending" }, 7)).toThrow(
            commitmentError,
        )
    })
})

describe("result root", () => {
    it("is the empty root for a block without transactions", async () => {
        expect(EMPTY_RESULTS_ROOT).toBe(toHex(EMPTY_ROOT))
        expect(await resultsRoot([], new Map(), 7)).toBe(EMPTY_RESULTS_ROOT)
    })

    it("is the RFC 6962 root over the leaves in block order", async () => {
        const a = confirmed(H(1), 7)
        const b = failed(H(2), 7, "TX_NONCE_INVALID_LOW")
        const c = confirmed(H(3), 7)
        const map = new Map([a, b, c].map(r => [r.hash, r]))
        const leaves = [a, b, c].map(r => resultLeaf(r, 7))

        const got = await resultsRoot([a.hash, b.hash, c.hash], map, 7)

        expect(got).toBe(toHex(root(leaves)))
        // Three leaves: MTH = node(node(l0, l1), l2)
        expect(got).toBe(
            toHex(nodeHash(nodeHash(leafHash(leaves[0]), leafHash(leaves[1])), leafHash(leaves[2]))),
        )
        expect(got).toMatch(/^[0-9a-f]{64}$/)
    })

    it("depends on the order and on each status and code", async () => {
        const a = confirmed(H(1), 7)
        const b = failed(H(2), 7, "TX_EXECUTE_FAILED")
        const map = new Map([a, b].map(r => [r.hash, r]))
        const base = await resultsRoot([a.hash, b.hash], map, 7)

        expect(await resultsRoot([b.hash, a.hash], map, 7)).not.toBe(base)
        const otherCode = new Map(map).set(b.hash, failed(H(2), 7, "TX_EXISTS"))
        expect(await resultsRoot([a.hash, b.hash], otherCode, 7)).not.toBe(base)
        const flipped = new Map(map).set(a.hash, failed(H(1), 7, null))
        expect(await resultsRoot([a.hash, b.hash], flipped, 7)).not.toBe(base)
    })

    it("refuses to commit to a transaction it holds no row for", async () => {
        await expect(resultsRoot([H(9)], new Map(), 7)).rejects.toBeInstanceOf(
            commitmentError,
        )
    })

    it("does not count genesis, whose transaction seeds the chain", async () => {
        const genesis = storeParent(0, [H(1)], [confirmed(H(1), 0)])
        expect(await parentResultsRoot(genesis)).toBe(EMPTY_RESULTS_ROOT)
        expect(getTransactionsFromHashes).not.toHaveBeenCalled()
    })

    it("reads the rows of the parent once per parent hash", async () => {
        const p = storeParent(4, [H(1), H(2)], [confirmed(H(1), 4), failed(H(2), 4, "TX_EXECUTE_FAILED")])
        const first = await parentResultsRoot(p)
        const second = await parentResultsRoot(p)
        expect(second).toBe(first)
        expect(getTransactionsFromHashes).toHaveBeenCalledTimes(1)
    })
})

describe("buildCommitments", () => {
    it("adds nothing before the fork", async () => {
        getSharedState.forkConfig.finalityProofs.activationHeight = null
        expect(await buildCommitments(5)).toBeNull()
        getSharedState.forkConfig.finalityProofs.activationHeight = 6
        expect(await buildCommitments(5)).toBeNull()
    })

    it("commits the height and the empty root for block 1", async () => {
        storeParent(0, [H(1)], [confirmed(H(1), 0)])
        expect(await buildCommitments(1)).toEqual({
            number: 1,
            parent_results_root: EMPTY_RESULTS_ROOT,
            validator_set_hash: SET_0,
        })
    })

    it("commits the empty root after an empty block", async () => {
        storeParent(4, [], [])
        expect((await buildCommitments(5))?.parent_results_root).toBe(EMPTY_RESULTS_ROOT)
    })

    it("commits the parent's results, failed and confirmed, in its order", async () => {
        const a = confirmed(H(1), 4)
        const b = failed(H(2), 4, "TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE")
        storeParent(4, [b.hash, a.hash], [a, b])

        const got = await buildCommitments(5)

        expect(got).toEqual({
            number: 5,
            parent_results_root: toHex(root([resultLeaf(b, 4), resultLeaf(a, 4)])),
            validator_set_hash: SET_0,
        })
        expect(Object.keys(got ?? {})).toEqual([
            "number",
            "parent_results_root",
            "validator_set_hash",
        ])
    })

    it("commits the set after the parent: the newest snapshot at or below it", async () => {
        storeParent(4, [], [])
        setHashes.set(3, SET_3)
        expect((await buildCommitments(5))?.validator_set_hash).toBe(SET_3)
        expect(validatorSetAt).toHaveBeenLastCalledWith(4)

        // A set recorded after block 4 belongs to block 6's commitment
        setHashes.set(5, H(55))
        storeParent(3, [], [])
        expect((await buildCommitments(4))?.validator_set_hash).toBe(SET_3)
    })

    it("refuses to forge without a snapshot of the parent's set", async () => {
        storeParent(4, [], [])
        setHashes = new Map()
        await expect(buildCommitments(5)).rejects.toBeInstanceOf(commitmentError)
    })

    it("refuses to forge without the parent block or one of its rows", async () => {
        await expect(buildCommitments(5)).rejects.toBeInstanceOf(commitmentError)
        storeParent(4, [H(1), H(2)], [confirmed(H(1), 4)])
        await expect(buildCommitments(5)).rejects.toBeInstanceOf(commitmentError)
    })
})

describe("verifyCommitments", () => {
    const a = confirmed(H(1), 4)
    const b = failed(H(2), 4, "TX_EXECUTE_FAILED")

    async function forged() {
        const p = storeParent(4, [a.hash, b.hash], [a, b])
        const commitments = await buildCommitments(5)
        return { block: { number: 5, content: content(commitments as any) }, prev: p }
    }

    it("accepts the commitments this node forges", async () => {
        const { block, prev } = await forged()
        expect(await verifyCommitments(block, prev)).toEqual({ valid: true })
    })

    it("rejects a block missing a field", async () => {
        const { block, prev } = await forged()
        delete (block.content as any).parent_results_root
        const verdict = await verifyCommitments(block, prev)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("does not end with")
    })

    it("rejects a wrong number", async () => {
        const { block, prev } = await forged()
        ;(block.content as any).number = 6
        const verdict = await verifyCommitments(block, prev)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("number")
    })

    it("rejects a tampered root", async () => {
        const { block, prev } = await forged()
        ;(block.content as any).parent_results_root = H(77)
        const verdict = await verifyCommitments(block, prev)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("parent_results_root mismatch")
    })

    it("rejects a root that is not lowercase hex", async () => {
        const { block, prev } = await forged()
        const real = (block.content as any).parent_results_root as string
        ;(block.content as any).parent_results_root = real.toUpperCase()
        expect((await verifyCommitments(block, prev)).reason).toContain("malformed")
    })

    it("rejects the fields out of their fixed order", async () => {
        const { block, prev } = await forged()
        const {
            number,
            parent_results_root: committedRoot,
            validator_set_hash: committedSet,
            ...rest
        } = block.content as any
        const swapped = {
            ...rest,
            number,
            validator_set_hash: committedSet,
            parent_results_root: committedRoot,
        }
        const verdict = await verifyCommitments({ number: 5, content: swapped }, prev)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("does not end with")
    })

    it("rejects a validator set hash this node does not hold", async () => {
        const { block, prev } = await forged()
        ;(block.content as any).validator_set_hash = H(9)
        const verdict = await verifyCommitments(block, prev)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("validator_set_hash mismatch")
    })

    it("rejects a malformed validator set hash", async () => {
        const { block, prev } = await forged()
        ;(block.content as any).validator_set_hash = SET_0.toUpperCase()
        expect((await verifyCommitments(block, prev)).reason).toContain(
            "malformed validator_set_hash",
        )
    })

    it("rejects a block when no snapshot backs the parent's set", async () => {
        const { block, prev } = await forged()
        setHashes = new Map()
        const verdict = await verifyCommitments(block, prev)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("cannot derive the validator set")
    })

    it("rejects a root the local rows cannot back", async () => {
        const { block, prev } = await forged()
        rows.delete(b.hash)
        resetCommitmentCache()
        const verdict = await verifyCommitments(block, prev)
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("cannot derive")
    })

    it("before the fork, accepts a block without the keys and rejects one with them", async () => {
        getSharedState.forkConfig.finalityProofs.activationHeight = null
        const prev = parent(4, [])
        expect(await verifyCommitments({ number: 5, content: content() }, prev)).toEqual({
            valid: true,
        })
        const verdict = await verifyCommitments(
            { number: 5, content: content({ number: 5 }) },
            prev,
        )
        expect(verdict.valid).toBe(false)
        expect(verdict.reason).toContain("before finalityProofs")
        expect(getTransactionsFromHashes).not.toHaveBeenCalled()
    })
})

describe("projectedResultsRoot", () => {
    it("equals the root the next block derives once the rows are stored", async () => {
        const a = confirmed(H(1), 5)
        const b = failed(H(2), 5, "TX_EXECUTE_FAILED")
        const block = parent(5, [a.hash, b.hash])

        const projected = await projectedResultsRoot(block, [a, b])

        storeParent(5, block.content.ordered_transactions, [a, b])
        expect(projected).toBe(await parentResultsRoot(block))
    })

    it("keeps the stored row of a transaction already on chain", async () => {
        rows.set(H(1), confirmed(H(1), 2))
        const block = parent(5, [H(1)])
        const served = failed(H(1), 5, "TX_EXISTS")

        const projected = await projectedResultsRoot(block, [served])

        expect(projected).toBe(toHex(root([resultLeaf(confirmed(H(1), 2), 5)])))
    })
})

it("uses the hashing of the shared primitives", () => {
    // Guards the literal against a drift of the tree module.
    expect(EMPTY_RESULTS_ROOT).toBe(createHash("sha256").update("").digest("hex"))
})
