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

jest.mock("src/libs/blockchain/validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            validate: jest.fn(async (txs: Array<{ hash: string }>) =>
                txs.map(t => ({ valid: true, hash: t.hash })),
            ),
        }),
    },
}))

jest.mock("src/libs/blockchain/validation/verifyGcrEdits", () => ({
    verifyGcrEditsMatch: jest.fn(async () => ({ match: true })),
}))

let insertedRows: Array<Record<string, unknown>> = []

jest.mock("src/libs/blockchain/chainDb", () => ({
    chunkedInsert: jest.fn(
        async (_repo: unknown, _entity: unknown, rows: Array<Record<string, unknown>>) => {
            insertedRows.push(...rows)
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

const tx = (hash: string, referenceBlock: number, status = "pending") =>
    ({
        hash,
        status,
        reference_block: referenceBlock,
        blockNumber: 100,
        content: { type: "demoswork", gcr_edits: [] },
    }) as any

describe("Mempool.receive admission", () => {
    beforeEach(() => {
        onChainHashes = new Set()
        insertedRows = []
        mempoolRows = []
        logError.mockClear()
        getExistingTransactionHashes.mockClear()
        ;(Mempool as any).repo = {
            find: jest.fn(async () => mempoolRows),
        }
    })

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

    it("normalizes peer-supplied status to pending before insert", async () => {
        await Mempool.receive([tx("0xpoisoned", 100, "failed")])
        expect(insertedRows).toHaveLength(1)
        expect(insertedRows[0].status).toBe(TRANSACTION_STATUS.PENDING)
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
})
