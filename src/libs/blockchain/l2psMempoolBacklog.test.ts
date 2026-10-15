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

const ROWS = 2000
const PAYLOAD_BYTES = 8 * 1024

let materialisedBytes = 0
let findCalls = 0

/** A table of executed rows that returns only the columns a query selects. */
function fakeRepo() {
    const table = Array.from({ length: ROWS }, (_, i) => ({
        hash: `0x${(ROWS - i).toString(16).padStart(8, "0")}`,
        l2ps_uid: "subnet_a",
        status: "executed",
        timestamp: String(1_700_000_000_000 + i),
        encrypted_tx: { content: { data: ["l2psEncryptedTx", { encrypted_data: "x".repeat(PAYLOAD_BYTES) }] } },
        gcr_edits: null,
    }))
    return {
        table,
        find: async (options: { select?: Record<string, boolean> }) => {
            findCalls++
            const selected = options.select
            const rows = table.map(row =>
                selected
                    ? Object.fromEntries(Object.keys(selected).map(key => [key, (row as any)[key]]))
                    : { ...row },
            )
            materialisedBytes += JSON.stringify(rows).length
            return rows
        },
    }
}

beforeEach(() => {
    materialisedBytes = 0
    findCalls = 0
})

describe("consolidated hash over an executed backlog", () => {
    it("materialises hashes only, however large the stored payloads are", async () => {
        const repo = fakeRepo()
        ;(L2PSMempool as any).repo = repo

        // The cycle repeats every few seconds; a leak-free read costs the same each time.
        for (let cycle = 0; cycle < 5; cycle++) {
            await L2PSMempool.getHashForL2PS("subnet_a")
        }

        const storedPayloadBytes = ROWS * PAYLOAD_BYTES
        expect(findCalls).toBe(5)
        expect(materialisedBytes / 5).toBeLessThan(storedPayloadBytes / 20)
    })

    it("leaves the digest unchanged", async () => {
        const repo = fakeRepo()
        ;(L2PSMempool as any).repo = repo

        const sorted = repo.table.map(row => row.hash).sort()
        const expected = Hashing.sha256(`L2PS_subnet_a_ALL:${sorted.length}:${sorted.join(",")}`)

        expect(await L2PSMempool.getHashForL2PS("subnet_a")).toBe(expected)
    })
})
