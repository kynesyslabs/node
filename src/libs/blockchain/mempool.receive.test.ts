import { beforeEach, describe, expect, it, jest } from "bun:test"

const logError = jest.fn()

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        warn: jest.fn(),
        error: logError,
        only: jest.fn(),
        custom: jest.fn(),
    },
}))

jest.mock("src/utilities/sharedState", () => ({
    getSharedState: {
        lastBlockNumber: 100,
        referenceBlockRoom: 1,
    },
}))

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

let onChainHashes = new Set<string>()
const getExistingTransactionHashes = jest.fn(async () => onChainHashes)

jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getLastBlockNumber: jest.fn(async () => 100),
        getExistingTransactionHashes,
    },
}))

jest.mock("@/forks", () => ({
    isForkActive: jest.fn(() => true),
}))

let blockCapsOn = false
jest.mock("@/forks/blockCapsGate", () => ({
    blockCapsActiveForPendingBlock: () => blockCapsOn,
}))

let badSignatures = new Set<string>()
jest.mock("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            validate: jest.fn(async (txs: Array<{ hash: string }>) => {
                // The verdict arrives after the call returns, as from a worker.
                await new Promise(resolve => setTimeout(resolve, 1))
                return txs.map(t =>
                    badSignatures.has(t.hash)
                        ? { valid: false, hash: t.hash, reason: "Invalid signature" }
                        : { valid: true, hash: t.hash },
                )
            }),
        }),
    },
}))

const editsVerdict: { ok: boolean; reason?: string } = { ok: true }
jest.mock("src/libs/blockchain/validation/editBinding", () => ({
    verifyAdmissionEdits: jest.fn(async () => editsVerdict),
}))

let insertedRows: Array<Record<string, unknown>> = []

jest.mock("src/libs/blockchain/chainDb", () => ({
    chunkedInsert: jest.fn(
        async (_repo: unknown, _entity: unknown, rows: Array<Record<string, unknown>>) => {
            insertedRows.push(...rows)
            // Inserted rows join the pool the per-sender cap reads.
            for (const row of rows as any[]) {
                if (typeof row.content?.from === "string") {
                    heldBySender.push({
                        hash: row.hash,
                        sender: row.content.from.toLowerCase(),
                        nonce: String(row.content.nonce),
                    })
                }
            }
            return { inserted: rows.length }
        },
    ),
}))

jest.mock("src/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: class {
        static lastBlockRef = 100
    },
}))

import Mempool from "./mempool"
import { TRANSACTION_STATUS } from "@/utilities/constants"

// lastBlock=100, referenceBlockRoom=1: deep window cutoff 100 - 5*1 = 95.
let mempoolRows: Array<{ hash: string }> = []
let heldBySender: Array<{ hash: string; sender: string; nonce: string }> = []
let deletedHashes: string[] = []

const tx = (hash: string, referenceBlock: number, status = "pending") =>
    ({
        hash,
        status,
        reference_block: referenceBlock,
        blockNumber: 100,
        content: { type: "demoswork", gcr_edits: [], timestamp: 1_700_000_000_000, nonce: 7 },
    }) as any

function resetReceiveState() {
    onChainHashes = new Set()
    badSignatures = new Set()
    insertedRows = []
    mempoolRows = []
    logError.mockClear()
    getExistingTransactionHashes.mockClear()
    blockCapsOn = false
    heldBySender = []
    deletedHashes = []
    ;(Mempool as any).repo = {
        find: jest.fn(async () => mempoolRows),
        query: jest.fn(async () => {
            // A read that takes time, as a database round trip does.
            const snapshot = [...heldBySender]
            await new Promise(resolve => setTimeout(resolve, 5))
            return snapshot
        }),
        delete: jest.fn(async (where: { hash: { value: string[] } }) => {
            deletedHashes.push(...where.hash.value)
            heldBySender = heldBySender.filter(
                row => !where.hash.value.includes(row.hash),
            )
            return { affected: where.hash.value.length }
        }),
    }
}

describe("Mempool.receive admission", () => {
    beforeEach(resetReceiveState)

    it("rejects txs already recorded on chain, failed or confirmed", async () => {
        onChainHashes = new Set(["0xseen"])
        const res = await Mempool.receive([tx("0xseen", 100), tx("0xnew", 100)])
        expect(res.success).toBe(true)
        expect(insertedRows.map(r => r.hash)).toEqual(["0xnew"])
        expect(
            logError.mock.calls.some(c =>
                String(c[0]).includes("already recorded on chain"),
            ),
        ).toBe(true)
    })

    it("admits expired-but-recent refs and rejects ancient and future refs", async () => {
        await Mempool.receive([
            tx("0xdeep", 96),
            tx("0xcutoff", 95),
            tx("0xancient", 94),
            tx("0xfuture", 101),
        ])
        expect(insertedRows.map(r => r.hash).sort()).toEqual([
            "0xcutoff",
            "0xdeep",
        ])
        expect(
            logError.mock.calls.filter(c =>
                String(c[0]).includes("outside the allowed window"),
            ),
        ).toHaveLength(2)
    })

    it("drops a tx whose signature fails and keeps the rest of the batch", async () => {
        badSignatures = new Set(["0xforged"])
        const res = await Mempool.receive([tx("0xa", 100), tx("0xforged", 100), tx("0xb", 100)])
        expect(res.success).toBe(true)
        expect(insertedRows.map(r => r.hash)).toEqual(["0xa", "0xb"])
    })

    it("normalizes peer-supplied status to pending before insert", async () => {
        await Mempool.receive([tx("0xpoisoned", 100, "failed")])
        expect(insertedRows).toHaveLength(1)
        expect(insertedRows[0].status).toBe(TRANSACTION_STATUS.PENDING)
    })

    it("stores the signed timestamp and nonce, not the ones the peer put beside them", async () => {
        const relayed = { ...tx("0xa", 100), timestamp: "bad", nonce: "bad" }
        await Mempool.receive([relayed])
        expect(insertedRows).toHaveLength(1)
        expect(insertedRows[0].timestamp).toBe(1_700_000_000_000)
        expect(insertedRows[0].nonce).toBe(7)
    })

    it("drops a tx whose unsigned integer columns Postgres cannot store and keeps the rest", async () => {
        // One such row would fail the insert of every tx merged with it.
        await Mempool.receive([
            { ...tx("0xblock", 100), blockNumber: "bad" },
            { ...tx("0xnull", 100), blockNumber: null },
            tx("0xfraction", 99.5),
            { ...tx("0xhuge", 100), blockNumber: 2 ** 31 },
            tx("0xa", 100),
        ])
        expect(insertedRows.map(r => r.hash)).toEqual(["0xa"])
    })

    it("skips txs already in the mempool without querying the chain for them", async () => {
        mempoolRows = [{ hash: "0xheld" }]
        await Mempool.receive([tx("0xheld", 100), tx("0xnew", 100)])
        expect(insertedRows.map(r => r.hash)).toEqual(["0xnew"])
        const queried = getExistingTransactionHashes.mock.calls[0][0] as string[]
        expect(queried).toEqual(["0xnew"])
    })

    it("returns success with an empty diff when everything incoming is known", async () => {
        mempoolRows = [{ hash: "0xheld" }]
        const res = await Mempool.receive([tx("0xheld", 100)])
        expect(res.success).toBe(true)
        expect(insertedRows).toHaveLength(0)
    })

    it("drops a tx admission would refuse before the chain is queried by its hash", async () => {
        // Postgres refuses U+0000 in the lookup's parameter, which would fail
        // the whole merge rather than this tx.
        await Mempool.receive([tx("0xbad\u0000", 100), tx("0xnew", 100)])
        expect(insertedRows.map(r => r.hash)).toEqual(["0xnew"])
        const queried = getExistingTransactionHashes.mock.calls[0][0] as string[]
        expect(queried).toEqual(["0xnew"])
    })

    it("rejects a tx whose edits the node would not generate", async () => {
        // This ingress is unauthenticated and handleGCR applies gcr_edits of
        // any type as written, so an edit the signed body does not imply is an
        // unauthenticated state change.
        editsVerdict.ok = false
        editsVerdict.reason = "gcr_edits do not match regenerated set"

        await Mempool.receive([tx("0xforged", 100)])

        expect(insertedRows).toHaveLength(0)
        expect(
            logError.mock.calls.filter(c =>
                String(c[0]).includes("gcr_edits do not match regenerated set"),
            ),
        ).toHaveLength(1)

        editsVerdict.ok = true
        editsVerdict.reason = undefined
    })
})

describe("Mempool.receive per-sender cap", () => {
    beforeEach(resetReceiveState)

    const SENDER = "0x" + "ab".repeat(32)
    const fromSender = (hash: string, nonce: number) => {
        const t = tx(hash, 100)
        t.content = { ...t.content, from: SENDER, nonce }
        return t
    }
    // The sender already holds the admission cap (64) in this pool.
    const fullHold = () =>
        Array.from({ length: 64 }, (_, i) => ({
            hash: `0xheld${i}`,
            sender: SENDER,
            nonce: String(i + 10),
        }))

    it("holds merged-in txs to the sender cap under blockCaps, keeping the lowest nonces", async () => {
        blockCapsOn = true
        heldBySender = fullHold()
        await Mempool.receive([fromSender("0xlow", 1), fromSender("0xhigh", 500)])
        // 0xlow outranks the held nonce 73, which leaves; 0xhigh does not fit.
        expect(insertedRows.map(r => r.hash)).toEqual(["0xlow"])
        expect(deletedHashes).toEqual(["0xheld63"])
    })

    it("keeps the sender cap when two merge exchanges overlap", async () => {
        blockCapsOn = true
        heldBySender = fullHold().slice(0, 63)
        await Promise.all([
            Mempool.receive([fromSender("0xa", 100)]),
            Mempool.receive([fromSender("0xb", 101)]),
        ])
        // Handled one after the other, the higher nonce gives way.
        expect(heldBySender).toHaveLength(64)
        expect(heldBySender.some(row => row.hash === "0xb")).toBe(false)
    })

    it("leaves the merge uncapped before the fork", async () => {
        heldBySender = fullHold()
        await Mempool.receive([fromSender("0xlow", 1), fromSender("0xhigh", 500)])
        expect(insertedRows.map(r => r.hash)).toEqual(["0xlow", "0xhigh"])
        expect(deletedHashes).toEqual([])
    })
})
