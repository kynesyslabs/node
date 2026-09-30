/**
 * What a history row keeps, and what deletes it.
 *
 * Two separate problems met in this table: it stored every transaction's
 * decrypted payload, and nothing but the mempool's five-minute sweep ever
 * removed L2PS data — so the readable copy was the durable one and expiry was
 * an accident of a cleanup job rather than a policy.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const save = jest.fn(async (row: any) => ({ ...row, id: 1 }))
const create = jest.fn((row: any) => row)
const execute = jest.fn(async () => ({ affected: 3 }))
const getMany = jest.fn(async () => [])
const rawQuery = jest.fn(async (_sql: string, _params: unknown[]) => [{ pruned: 3 }])

const whereClauses: Array<{ clause: string; params: any }> = []

const queryBuilder = {
    where(clause: string, params: any) {
        whereClauses.push({ clause, params })
        return this
    },
    andWhere(clause: string, params: any) {
        whereClauses.push({ clause, params })
        return this
    },
    delete() {
        return this
    },
    from() {
        return this
    },
    orderBy() {
        return this
    },
    take() {
        return this
    },
    skip() {
        return this
    },
    execute,
    getMany,
}

const storePlaintext = { value: false }

jest.mock("src/config", () => ({
    Config: {
        getInstance: () => ({
            l2ps: {
                get historyStorePlaintext() {
                    return storePlaintext.value
                },
            },
        }),
    },
}))

jest.mock("@/utilities/logger", () => ({
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

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({
                query: rawQuery,
                getRepository: () => ({
                    create,
                    save,
                    createQueryBuilder: () => queryBuilder,
                }),
            }),
        }),
    },
}))

import L2PSTransactionExecutor from "./L2PSTransactionExecutor"

const TX_HASH = "ab".repeat(32)
const TX_CONTENT = {
    type: "native",
    from: "sender",
    to: "recipient",
    amount: 10,
    nonce: 1,
    timestamp: 1_700_000_000_000,
    data: ["native", { message: "lunch money" }],
}
const TX = { hash: TX_HASH, content: TX_CONTENT } as never

const ENVELOPE = { content: { data: ["l2ps", { ciphertext: "…" }] } }

beforeEach(() => {
    save.mockClear()
    create.mockClear()
    execute.mockClear()
    rawQuery.mockClear()
    whereClauses.length = 0
    storePlaintext.value = false
    // The executor caches its L1 repository handle across calls.
    ;(L2PSTransactionExecutor as unknown as { l1Repo: unknown }).l1Repo = {}
})

describe("recordTransaction", () => {
    it("keeps the ciphertext and not the message", async () => {
        await L2PSTransactionExecutor.recordTransaction(
            "subnet-1",
            TX,
            "",
            "encrypted-hash",
            0,
            "pending",
            ENVELOPE,
        )

        const row = create.mock.calls[0][0]
        expect(row.encrypted_payload).toEqual(ENVELOPE)
        expect(row.content).toBeNull()
        expect(JSON.stringify(row)).not.toContain("lunch money")
    })

    it("keeps the plaintext too when a node asks for it", async () => {
        storePlaintext.value = true

        await L2PSTransactionExecutor.recordTransaction(
            "subnet-1",
            TX,
            "",
            "encrypted-hash",
            0,
            "pending",
            ENVELOPE,
        )

        expect(create.mock.calls[0][0].content).toEqual(TX_CONTENT)
    })

    it("still records the routing metadata the account query selects on", async () => {
        await L2PSTransactionExecutor.recordTransaction(
            "subnet-1",
            TX,
            "",
            "encrypted-hash",
            0,
            "pending",
            ENVELOPE,
        )

        const row = create.mock.calls[0][0]
        expect(row.from_address).toBe("sender")
        expect(row.to_address).toBe("recipient")
        expect(row.hash).toBe(TX_HASH)
    })
})

describe("pruneHistory", () => {
    it("deletes nothing when no retention is configured", async () => {
        await expect(L2PSTransactionExecutor.pruneHistory(0)).resolves.toBe(0)
        expect(execute).not.toHaveBeenCalled()
        expect(rawQuery).not.toHaveBeenCalled()
    })

    it("deletes nothing for a negative retention", async () => {
        await expect(L2PSTransactionExecutor.pruneHistory(-1)).resolves.toBe(0)
        expect(execute).not.toHaveBeenCalled()
        expect(rawQuery).not.toHaveBeenCalled()
    })

    it("cuts off at the configured age, measured from when the row was written", async () => {
        const before = Date.now()

        await expect(L2PSTransactionExecutor.pruneHistory(30)).resolves.toBe(3)

        const [sql, params] = rawQuery.mock.calls.at(-1)!
        expect(sql).toContain("created_at")
        // Epoch milliseconds, converted by the database: a JS Date would be
        // serialised in the process's zone and shifted by the offset.
        expect(typeof params[0]).toBe("number")
        const cutoff = Number(params[0])
        const thirtyDays = 30 * 24 * 60 * 60 * 1000
        expect(cutoff).toBeGreaterThanOrEqual(before - thirtyDays - 5_000)
        expect(cutoff).toBeLessThanOrEqual(Date.now() - thirtyDays)
    })

    it("keeps the hash of every row it deletes, in the same statement", async () => {
        // The replay check reads the history table; a prune must not make an
        // executed transfer look new.
        await L2PSTransactionExecutor.pruneHistory(30)

        const [sql] = rawQuery.mock.calls.at(-1)!
        expect(sql).toMatch(/DELETE FROM "l2ps_transactions"/)
        expect(sql).toMatch(/INSERT INTO "l2ps_executed_hashes"/)
        expect(sql).toMatch(/RETURNING "hash"/)
    })
})

describe("getSubnetTransactions", () => {
    it("pages oldest first after a row id this node issued", async () => {
        // Newest-first paging cannot drain a backlog: every round hands back
        // the same newest page while everything older stays behind whatever
        // the peer last recorded.
        getMany.mockResolvedValueOnce([
            { id: 11, hash: "a" },
            { id: 12, hash: "b" },
        ] as never)

        const page = await L2PSTransactionExecutor.getSubnetTransactions("subnet-1", 500, { afterId: 10 })

        expect(page.rows).toHaveLength(2)
        expect(page.nextCursor).toBe(12)
        expect(page.hasMore).toBe(false)
        const cursor = whereClauses.find(c => c.clause.includes(":afterId"))
        expect(cursor?.clause).toBe("tx.id > :afterId")
        expect(cursor?.params.afterId).toBe(10)
    })

    it("says there is more only when a row past the page exists", async () => {
        getMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }] as never)
        const full = await L2PSTransactionExecutor.getSubnetTransactions("subnet-1", 2)
        expect(full.rows.map(r => r.id)).toEqual([1, 2])
        expect(full.nextCursor).toBe(2)
        expect(full.hasMore).toBe(true)

        getMany.mockResolvedValueOnce([{ id: 3 }, { id: 4 }] as never)
        const last = await L2PSTransactionExecutor.getSubnetTransactions("subnet-1", 2, { afterId: 2 })
        expect(last.rows).toHaveLength(2)
        expect(last.hasMore).toBe(false)
    })

    it("holds the cursor where it was when a page comes back empty", async () => {
        getMany.mockResolvedValueOnce([] as never)

        const page = await L2PSTransactionExecutor.getSubnetTransactions("subnet-1", 500, { afterId: 42 })

        expect(page.rows).toEqual([])
        expect(page.nextCursor).toBe(42)
        expect(page.hasMore).toBe(false)
    })

    it("starts from a record time for peers that predate the cursor", async () => {
        getMany.mockResolvedValueOnce([] as never)

        await L2PSTransactionExecutor.getSubnetTransactions("subnet-1", 500, { sinceMs: 1_700_000_000_000 })

        const since = whereClauses.find(c => c.clause.includes(":since"))
        expect(since?.params.since).toBe(1_700_000_000_000)
        expect(since?.clause).toContain("to_timestamp")
    })

    it("asks for everything when the peer has no cursor yet", async () => {
        getMany.mockResolvedValueOnce([] as never)

        await L2PSTransactionExecutor.getSubnetTransactions("subnet-1", 500)

        expect(whereClauses).toHaveLength(1)
    })
})

describe("getAccountTransactions", () => {
    it("asks only for what is newer than the caller's cursor", async () => {
        await L2PSTransactionExecutor.getAccountTransactions(
            "subnet-1",
            "sender",
            100,
            0,
            1_700_000_000_000,
        )

        const since = whereClauses.find(c => c.clause.includes("tx.timestamp > :since"))
        expect(since?.params.since).toBe("1700000000000")
    })

    it("does not filter by time when no cursor is given", async () => {
        await L2PSTransactionExecutor.getAccountTransactions("subnet-1", "sender")

        expect(whereClauses.some(c => c.clause.includes(":since"))).toBe(false)
    })
})
