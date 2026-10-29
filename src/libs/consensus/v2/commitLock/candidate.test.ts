/**
 * Step 1 of a commitLock round: which block an attempt prevotes, and how a
 * locked or proof-of-lock block is rebuilt from its inputs, fetching the
 * transactions this node lacks.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const sharedState: Record<string, any> = {
    lastBlockNumber: 9,
    lastBlockHash: "hash-9",
    genesisBlockHash: "hash-0",
    identityFile: "",
    publicKeyHex: "self",
    referenceBlockRoom: 10,
    batchSyncTxSize: 1000,
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
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    default: sharedState,
    getSharedState: sharedState,
}))

interface Tx {
    hash: string
    reference_block: number
    blockNumber?: number
    status?: string
    content: { nonce: number; gcr_edits: { type: string; account: string }[] }
}

const mempool = new Map<string, Tx>()
const received: Tx[][] = []
jest.mock("src/libs/blockchain/mempool", () => ({
    __esModule: true,
    default: {
        getTransactionsByHashes: async (hashes: string[]) =>
            hashes.filter(h => mempool.has(h)).map(h => structuredClone(mempool.get(h))),
        receive: async (txs: Tx[]) => {
            received.push(txs)
            for (const tx of txs) mempool.set(tx.hash, structuredClone(tx))
            return { success: true, mempool: [] }
        },
    },
}))
const nonces: Record<string, number> = {}
jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getAccountNonces: async (accounts: string[]) => Object.fromEntries(accounts.map(a => [a, nonces[a] ?? 0])) },
}))
jest.mock("@/libs/l2ps/editConservation", () => ({ normalizeAccount: (a: string) => a }))

const fetched = { locks: [] as any[], committed: [] as any[], asked: 0 }
jest.mock("./getLock", () => ({
    fetchLocks: async () => {
        fetched.asked++
        return { locks: fetched.locks, committed: fetched.committed }
    },
}))
jest.mock("./precommit", () => ({ committeePeers: () => [] }))

const { chooseCandidates, gatherRetryCandidates, rebuildTransactions } = await import("./candidate")
const lockStore = await import("./lockStore")
const roundState = await import("./roundState")
const signingRecord = await import("src/libs/identity/signingRecord")

function recordPrecommit(height: number, round: number, hash: string, genesisHash = "hash-0") {
    signingRecord.recordBlockSignature(sharedState.identityFile, {
        genesisHash,
        height,
        timestamp: round,
        hash,
    })
}

const inputs = (txs: string[], timestamp = 1500) => ({
    previousHash: "hash-9",
    orderedTransactions: txs,
    peerlist: ["a", "b", "c", "d"],
    timestamp,
})

function ownLock(hash: string, round: number) {
    return {
        genesisHash: "hash-0",
        height: 10,
        hash,
        round,
        pol: {},
        inputs: inputs(["own"]),
        lockedAt: 1,
    }
}

const reported = (hash: string, round: number, source: string, txs = [hash]) => ({
    hash,
    round,
    pol: {},
    inputs: inputs(txs),
    source,
})

function tx(hash: string, nonce: number, account = "acc", reference_block = 9): Tx {
    return { hash, reference_block, content: { nonce, gcr_edits: [{ type: "nonce", account }] } }
}

let dir: string

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-candidate-"))
    sharedState.identityFile = path.join(dir, ".demos_identity")
    mempool.clear()
    received.length = 0
    for (const k of Object.keys(nonces)) delete nonces[k]
    fetched.locks = []
    fetched.committed = []
    fetched.asked = 0
    roundState.__resetRoundState()
})

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

describe("candidate order", () => {
    it("is fresh when nothing is locked or reported", () => {
        expect(chooseCandidates(null, [])).toEqual([])
    })

    it("takes the highest-round proof of lock first when unlocked", () => {
        const options = chooseCandidates(null, [
            reported("x", 5000, "a"),
            reported("y", 5010, "b"),
            reported("x", 5020, "c", ["x", "z"]),
        ])
        expect(options.map(o => [o.hash, o.round])).toEqual([
            ["x", 5020],
            ["y", 5010],
        ])
        expect(options[0].variants).toHaveLength(2)
        expect(options[0].sources).toEqual(["a", "c"])
    })

    it("keeps a locked member on its block unless a later proof of lock exists", () => {
        const options = chooseCandidates(ownLock("x", 5010), [
            reported("y", 5000, "a"),
            reported("y", 5010, "b"),
        ])
        expect(options.map(o => [o.origin, o.hash])).toEqual([["lock", "x"]])
    })

    it("tries a later proof of lock for another block before its own lock", () => {
        const options = chooseCandidates(ownLock("x", 5000), [
            reported("y", 5010, "a"),
            reported("z", 5020, "b"),
            reported("x", 5000, "c", ["x", "other"]),
        ])
        expect(options.map(o => [o.origin, o.hash])).toEqual([
            ["pol", "z"],
            ["pol", "y"],
            ["lock", "x"],
        ])
        const own = options[2]
        expect(own.variants[0]).toEqual(inputs(["own"]))
        expect(own.variants).toHaveLength(2)
        expect(own.sources).toEqual(["c"])
    })
})

describe("gathering the retry's candidates", () => {
    it("closes the previous prevote before choosing", async () => {
        roundState.recordPrevote({ height: 10, round: 5000, hash: "x", inputs: inputs([]) })
        await gatherRetryCandidates(10, false, ["self", "a", "b", "c"])
        expect(roundState.openPrevote(10, 5000, "x")).toBeNull()
    })

    it("asks nobody on a first attempt without a lock", async () => {
        const result = await gatherRetryCandidates(10, false, ["self", "a"])
        expect(fetched.asked).toBe(0)
        expect(result).toEqual({ locked: null, bound: null, options: [], committed: [] })
    })

    it("asks the committee on a retry", async () => {
        fetched.locks = [reported("y", 5010, "a")]
        const result = await gatherRetryCandidates(10, true, ["self", "a"])
        expect(fetched.asked).toBe(1)
        expect(result.options.map(o => o.hash)).toEqual(["y"])
    })

    it("asks the committee while its own lock binds the height, even after a restart", async () => {
        lockStore.writeCommitLock(sharedState.identityFile, ownLock("x", 5000))
        const result = await gatherRetryCandidates(10, false, ["self", "a"])
        expect(fetched.asked).toBe(1)
        expect(result.locked?.hash).toBe("x")
        expect(result.options.map(o => o.hash)).toEqual(["x"])
    })
})

describe("a precommit in the signing record without its lock file", () => {
    it("binds a first attempt and asks the committee, even with nobody reporting", async () => {
        recordPrecommit(10, 5000, "x")
        const result = await gatherRetryCandidates(10, false, ["self", "a"])
        expect(fetched.asked).toBe(1)
        expect(result.locked).toBeNull()
        expect(result.bound).toContain("height 10")
        expect(result.options).toEqual([])
    })

    it("takes the recorded block as a member reports it", async () => {
        recordPrecommit(10, 5000, "x")
        fetched.locks = [reported("x", 5000, "a")]
        const result = await gatherRetryCandidates(10, false, ["self", "a"])
        expect(result.options.map(o => [o.origin, o.hash])).toEqual([["lock", "x"]])
    })

    it("takes another block only on a proof of lock above the recorded round", async () => {
        recordPrecommit(10, 5000, "x")
        fetched.locks = [reported("y", 5000, "a"), reported("z", 4000, "b")]
        expect((await gatherRetryCandidates(10, true, ["self", "a", "b"])).options).toEqual([])

        fetched.locks = [reported("y", 5010, "a"), reported("x", 5000, "b")]
        const result = await gatherRetryCandidates(10, true, ["self", "a", "b"])
        expect(result.bound).not.toBeNull()
        expect(result.options.map(o => o.hash)).toEqual(["y", "x"])
    })

    it("allows nothing when the record is above the height", async () => {
        recordPrecommit(11, 5000, "x")
        fetched.locks = [reported("y", 6000, "a")]
        const result = await gatherRetryCandidates(10, false, ["self", "a"])
        expect(result.bound).toContain("height 11")
        expect(result.options).toEqual([])
    })

    it("does not bind the next height", async () => {
        recordPrecommit(9, 5000, "x")
        const result = await gatherRetryCandidates(10, false, ["self", "a"])
        expect(fetched.asked).toBe(0)
        expect(result).toEqual({ locked: null, bound: null, options: [], committed: [] })
    })

    it("ignores a record of another chain", async () => {
        recordPrecommit(10, 5000, "x", "other-genesis")
        const result = await gatherRetryCandidates(10, false, ["self", "a"])
        expect(result).toEqual({ locked: null, bound: null, options: [], committed: [] })
    })

    it("leaves the lock rule to the lock file when it binds the height", async () => {
        lockStore.writeCommitLock(sharedState.identityFile, ownLock("x", 5000))
        recordPrecommit(10, 5000, "x")
        fetched.locks = [reported("y", 5010, "a")]
        const result = await gatherRetryCandidates(10, false, ["self", "a"])
        expect(result.bound).toBeNull()
        expect(result.options.map(o => [o.origin, o.hash])).toEqual([
            ["pol", "y"],
            ["lock", "x"],
        ])
    })

    it("fails on a record it cannot read", async () => {
        fs.writeFileSync(signingRecord.signingRecordPath(sharedState.identityFile), "{")
        await expect(gatherRetryCandidates(10, false, ["self", "a"])).rejects.toBeInstanceOf(
            signingRecord.SigningRecordError,
        )
        expect(fetched.asked).toBe(0)
    })
})

describe("rebuilding a block's transactions", () => {
    it("returns the transactions in the block's order", async () => {
        mempool.set("t2", tx("t2", 2))
        mempool.set("t1", tx("t1", 1))
        const rebuilt = await rebuildTransactions(10, inputs(["t1", "t2"]), [])
        expect(rebuilt?.txs.map(t => t.hash)).toEqual(["t1", "t2"])
        expect(rebuilt?.txs.every(t => t.blockNumber === 10)).toBe(true)
        expect(rebuilt?.failedTxs).toEqual([])
    })

    it("fetches missing transactions from the members that reported the block", async () => {
        mempool.set("t1", tx("t1", 1))
        const calls: string[][] = []
        const source = {
            identity: "a",
            call: async (req: any) => {
                calls.push(req.params[0].data.hashes)
                return { result: 200, response: [tx("t2", 2), tx("unasked", 9)] }
            },
        }
        const rebuilt = await rebuildTransactions(10, inputs(["t1", "t2"]), [source as any])
        expect(calls).toEqual([["t2"]])
        expect(received[0].map(t => t.hash)).toEqual(["t2"])
        expect(rebuilt?.txs.map(t => t.hash)).toEqual(["t1", "t2"])
    })

    it("asks for a large block's missing transactions in batches", async () => {
        sharedState.batchSyncTxSize = 2
        try {
            const calls: string[][] = []
            const source = {
                identity: "a",
                call: async (req: any) => {
                    const hashes: string[] = req.params[0].data.hashes
                    calls.push(hashes)
                    return { result: 200, response: hashes.map(h => tx(h, 1, h)) }
                },
            }
            const block = ["t1", "t2", "t3", "t4", "t5"]
            const rebuilt = await rebuildTransactions(10, inputs(block), [source as any])
            expect(calls).toEqual([["t1", "t2"], ["t3", "t4"], ["t5"]])
            expect(rebuilt?.txs.map(t => t.hash)).toEqual(block)
        } finally {
            sharedState.batchSyncTxSize = 1000
        }
    })

    it("gives up when a transaction cannot be found", async () => {
        mempool.set("t1", tx("t1", 1))
        const source = { identity: "a", call: async () => ({ result: 404, response: [] }) }
        expect(await rebuildTransactions(10, inputs(["t1", "t2"]), [source as any])).toBeNull()
    })

    it("gives up when the mempool filters would leave a transaction out", async () => {
        mempool.set("t1", tx("t1", 1))
        mempool.set("t3", tx("t3", 3))
        expect(await rebuildTransactions(10, inputs(["t1", "t3"]), [])).toBeNull()
    })

    it("keeps a transaction the filters include as failed, as the fresh path does", async () => {
        mempool.set("t0", tx("t0", 0))
        mempool.set("t1", tx("t1", 1))
        const rebuilt = await rebuildTransactions(10, inputs(["t0", "t1"]), [])
        expect(rebuilt?.txs.map(t => [t.hash, t.status])).toEqual([
            ["t0", "failed"],
            ["t1", undefined],
        ])
    })

    it("refuses inputs that extend another parent", async () => {
        expect(
            await rebuildTransactions(10, { ...inputs([]), previousHash: "other" }, []),
        ).toBeNull()
    })
})
