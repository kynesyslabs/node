/**
 * Reading a large executed backlog for its consolidated hash.
 *
 * The hash cycle reads the whole backlog every few seconds. What a read
 * materialises has to follow the number of rows, not the size of each row's
 * encrypted payload, or a backlog turns every cycle into an allocation spike.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { Hashing } from "@kynesyslabs/demosdk/encryption"

mock.module("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: async () => ({ getDataSource: () => ({}) }) },
}))
mock.module("@/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: { getInstance: () => ({}) },
}))
mock.module("@/utilities/logger", () => ({
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

const { default: L2PSMempool } = await import("./l2ps_mempool")

const ROWS = 12_345
const PAYLOAD_BYTES = 8 * 1024

let largestFetch = 0
let transactions = 0
let materialisedBytes = 0

/**
 * A table of executed rows behind the few statements the digest issues: a
 * count, a cursor sorted by byte order, and fetches from it.
 */
function fakeRepo() {
    const table = Array.from({ length: ROWS }, (_, i) => ({
        hash: i % 2 ? `0x${(ROWS - i).toString(16).padStart(8, "0")}` : `0X${(ROWS - i).toString(16).toUpperCase().padStart(8, "0")}`,
        encrypted_tx: { content: { data: ["l2psEncryptedTx", { encrypted_data: "x".repeat(PAYLOAD_BYTES) }] } },
    }))
    let cursor: string[] = []
    const manager = {
        getRepository: () => ({ metadata: { tablePath: "l2ps_mempool" } }),
        query: async (sql: string) => {
            if (sql.startsWith("SELECT COUNT")) return [{ count: String(table.length) }]
            if (sql.startsWith("DECLARE")) {
                // Code-unit order, which is what the in-memory sort produced.
                cursor = table.map(row => row.hash).sort()
                return []
            }
            if (sql.startsWith("FETCH")) {
                const n = Number(sql.split(" ")[1])
                const rows = cursor.splice(0, n).map(hash => ({ hash }))
                largestFetch = Math.max(largestFetch, rows.length)
                materialisedBytes += JSON.stringify(rows).length
                return rows
            }
            return []
        },
    }
    return {
        table,
        manager: {
            transaction: async (_level: string, work: (m: typeof manager) => Promise<unknown>) => {
                transactions++
                return work(manager)
            },
        },
    }
}

beforeEach(() => {
    largestFetch = 0
    transactions = 0
    materialisedBytes = 0
})

describe("consolidated hash over an executed backlog", () => {
    it("reads the backlog in bounded pages, however large the stored payloads are", async () => {
        const repo = fakeRepo()
        ;(L2PSMempool as any).repo = repo

        // The cycle repeats every few seconds; a leak-free read costs the same each time.
        for (let cycle = 0; cycle < 5; cycle++) {
            await L2PSMempool.getHashForL2PS("subnet_a")
        }

        const storedPayloadBytes = ROWS * PAYLOAD_BYTES
        expect(transactions).toBe(5)
        expect(largestFetch).toBeLessThanOrEqual(5000)
        expect(materialisedBytes / 5).toBeLessThan(storedPayloadBytes / 20)
    })

    it("leaves the digest unchanged", async () => {
        const repo = fakeRepo()
        ;(L2PSMempool as any).repo = repo

        const sorted = repo.table.map(row => row.hash).sort()
        const expected = Hashing.sha256(`L2PS_subnet_a_ALL:${sorted.length}:${sorted.join(",")}`)

        expect(await L2PSMempool.getHashForL2PS("subnet_a")).toBe(expected)
    })

    it("returns the count from the same snapshot as the digest", async () => {
        const repo = fakeRepo()
        ;(L2PSMempool as any).repo = repo

        const { hash, count } = await L2PSMempool.getDigestWithCount("subnet_a")

        expect(count).toBe(ROWS)
        expect(hash).toBe(await L2PSMempool.getHashForL2PS("subnet_a"))
        expect(transactions).toBe(2)
    })

    it("throws when the database cannot be read, and never returns a stand-in hash", async () => {
        ;(L2PSMempool as any).repo = {
            manager: {
                transaction: async () => {
                    throw new Error("connection lost")
                },
            },
        }

        await expect(L2PSMempool.getHashForL2PS("subnet_a")).rejects.toThrow("connection lost")
        await expect(L2PSMempool.getDigestWithCount("subnet_a")).rejects.toThrow("connection lost")
    })
})
