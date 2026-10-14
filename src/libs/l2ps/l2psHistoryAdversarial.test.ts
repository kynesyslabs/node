/**
 * Hostile values against the history table reads, the retention sweep and the
 * record path, with the query builder replaced by a recorder.
 *
 * What is asserted is what reaches the database: that caller-controlled text
 * stays in parameters, that a value the database cannot take never reaches it,
 * and that the order a page is read in does not depend on the caller.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const save = jest.fn(async (row: any) => ({ ...row, id: 1 }))
const create = jest.fn((row: any) => row)
const getMany = jest.fn(async () => [])
const rawQuery = jest.fn(async (_sql: string, _params: unknown[]) => [{ pruned: 3 }])

const whereClauses: Array<{ clause: string; params: any }> = []
const taken: unknown[] = []
const skipped: unknown[] = []
const orderings: string[] = []

// Every builder method is recorded by name and chains; only the two that end
// a query answer. What a test reads back is what the code asked the database.
const recordWhere = ([clause, params]: unknown[]) => whereClauses.push({ clause: String(clause), params })
const recordOrder = ([column, direction]: unknown[]) => orderings.push(`${column} ${direction}`)
const recorders: Record<string, (args: unknown[]) => unknown> = {
    where: recordWhere,
    andWhere: recordWhere,
    orderBy: recordOrder,
    addOrderBy: recordOrder,
    take: ([n]) => taken.push(n),
    skip: ([n]) => skipped.push(n),
}
const queryBuilder: any = new Proxy({}, {
    get: (_target, method: string) =>
        method === "getMany"
            ? getMany
            : (...args: unknown[]) => {
                recorders[method]?.(args)
                return queryBuilder
            },
})

const storePlaintext = { value: false }

jest.mock("src/config", () => ({
    Config: { getInstance: () => ({ l2ps: { get historyStorePlaintext() { return storePlaintext.value } } }) },
}))
jest.mock("@/utilities/logger", () => ({ __esModule: true, default: new Proxy({}, { get: () => jest.fn() }) }))
jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({ query: rawQuery, getRepository: () => ({ create, save, createQueryBuilder: () => queryBuilder }) }),
        }),
    },
}))

import L2PSTransactionExecutor from "./L2PSTransactionExecutor"

beforeEach(() => {
    save.mockClear()
    create.mockClear()
    rawQuery.mockClear()
    getMany.mockClear()
    whereClauses.length = 0
    orderings.length = 0
    taken.length = 0
    skipped.length = 0
    storePlaintext.value = false
    ;(L2PSTransactionExecutor as unknown as { l1Repo: unknown }).l1Repo = {}
})

const DAY = 24 * 60 * 60 * 1000

describe("pruneHistory with a retention the database cannot take", () => {
    it.each([[NaN], [Infinity], [-Infinity], [1e9], [1e300], [Number.MAX_SAFE_INTEGER], ["abc" as unknown as number], [undefined as unknown as number], [null as unknown as number]])(
        "%p deletes nothing and sends no cutoff the database would reject",
        async retention => {
            await expect(L2PSTransactionExecutor.pruneHistory(retention)).resolves.toBe(0)

            for (const [, params] of rawQuery.mock.calls) {
                const cutoff = Number(params[0])
                // to_timestamp has a finite range; before the epoch nothing was written.
                expect(Number.isFinite(cutoff)).toBe(true)
                expect(cutoff).toBeGreaterThan(0)
            }
        },
    )

    it("a retention just short of the epoch reaches the database with a positive cutoff", async () => {
        const days = Math.floor(Date.now() / DAY) - 1
        await L2PSTransactionExecutor.pruneHistory(days)

        const [, params] = rawQuery.mock.calls.at(-1)!
        expect(Number(params[0])).toBeGreaterThan(0)
    })

    it("a fractional retention is honoured, not rounded to zero or to a day", async () => {
        const before = Date.now()
        await L2PSTransactionExecutor.pruneHistory(0.5)

        const [, params] = rawQuery.mock.calls.at(-1)!
        expect(Number(params[0])).toBeGreaterThanOrEqual(before - 0.5 * DAY - 5_000)
        expect(Number(params[0])).toBeLessThanOrEqual(Date.now() - 0.5 * DAY)
    })

    it("a sweep that reports no row count is zero rather than NaN", async () => {
        rawQuery.mockResolvedValueOnce([{ pruned: null }] as never)
        await expect(L2PSTransactionExecutor.pruneHistory(30)).resolves.toBe(0)
    })

    it("deletes strictly before the cutoff, so a row exactly at it stays", async () => {
        await L2PSTransactionExecutor.pruneHistory(30)

        const [sql] = rawQuery.mock.calls.at(-1)!
        expect(sql).toMatch(/"created_at" < to_timestamp/)
        expect(sql).not.toMatch(/"created_at" <= /)
    })

    it("keeps the hash of a pruned row even when the same hash was already kept", async () => {
        await L2PSTransactionExecutor.pruneHistory(30)

        const [sql] = rawQuery.mock.calls.at(-1)!
        expect(sql).toContain('ON CONFLICT ("hash") DO NOTHING')
    })
})

describe("getAccountTransactions with a hostile address and subnet", () => {
    const hostile = ["x' OR '1'='1", "'; DROP TABLE l2ps_transactions; --", "%", "_", "\\", "\u0000", "a".repeat(100_000)]

    it.each(hostile.map(h => [h.slice(0, 20), h]))("keeps %p in a parameter, not in the statement", async (_n, text) => {
        await L2PSTransactionExecutor.getAccountTransactions(text, text, 10, 0, 0)

        const values = whereClauses.flatMap(w => Object.values(w.params))
        expect(values).toContain(text)
        for (const { clause } of whereClauses) {
            if (text.length > 3) expect(clause).not.toContain(text)
            // Exact match, never a pattern: a % or _ in an address must not widen the read.
            expect(clause).not.toMatch(/LIKE/i)
        }
    })

    it("matches the party by equality on both sides, so a self-transfer is one row", async () => {
        await L2PSTransactionExecutor.getAccountTransactions("s", "0xabc", 10, 0, 0)

        const party = whereClauses.find(w => w.clause.includes("from_address"))!
        expect(party.clause).toBe("(tx.from_address = :pubkey OR tx.to_address = :pubkey)")
        expect(whereClauses[0].clause).toBe("tx.l2ps_uid = :l2psUid")
    })

    it("scopes every read to the subnet", async () => {
        await L2PSTransactionExecutor.getAccountTransactions("subnet-x", "0xabc", 10, 0, 5)
        expect(whereClauses[0]).toEqual({ clause: "tx.l2ps_uid = :l2psUid", params: { l2psUid: "subnet-x" } })
    })

    it("orders newest first with the id as the tiebreak, whatever the page", async () => {
        for (const [limit, offset, since] of [[1, 0, 0], [1000, 5, 7], [10, 1e9, 1e12]]) {
            orderings.length = 0
            await L2PSTransactionExecutor.getAccountTransactions("s", "0xabc", limit, offset, since)
            expect(orderings).toEqual(["tx.timestamp DESC", "tx.id DESC"])
        }
    })

    it("applies since as a strict lower bound and only when positive", async () => {
        await L2PSTransactionExecutor.getAccountTransactions("s", "0xabc", 10, 0, 0)
        expect(whereClauses.some(w => w.clause.includes("timestamp"))).toBe(false)

        whereClauses.length = 0
        await L2PSTransactionExecutor.getAccountTransactions("s", "0xabc", 10, 0, 1700000000000)
        const since = whereClauses.find(w => w.clause.includes("timestamp"))!
        expect(since.clause).toBe("tx.timestamp > :since")
        expect(since.params).toEqual({ since: "1700000000000" })
    })

    it("hands limit and offset to the query unchanged, for the caller to have bounded", async () => {
        await L2PSTransactionExecutor.getAccountTransactions("s", "0xabc", 101, 50, 0)
        expect(taken).toEqual([101])
        expect(skipped).toEqual([50])
    })
})

describe("getSubnetTransactions with hostile cursors", () => {
    it("prefers the row id cursor over the time cursor, so a peer cannot rewind it", async () => {
        await L2PSTransactionExecutor.getSubnetTransactions("s", 10, { afterId: 5, sinceMs: 1 })

        expect(whereClauses.map(w => w.clause)).toEqual(["tx.l2ps_uid = :l2psUid", "tx.id > :afterId"])
    })

    it.each([[NaN], [-5], [0], [undefined]])("a cursor of %p reads from the start", async afterId => {
        await L2PSTransactionExecutor.getSubnetTransactions("s", 10, { afterId: afterId as number })
        expect(whereClauses.some(w => w.clause.includes("afterId"))).toBe(false)
    })

    it("pages oldest first by id and asks for one row past the page", async () => {
        await L2PSTransactionExecutor.getSubnetTransactions("s", 10, {})
        expect(orderings).toEqual(["tx.id ASC"])
        expect(taken).toEqual([11])
    })

    it("an empty page keeps the cursor where it was", async () => {
        getMany.mockResolvedValueOnce([] as never)
        const page = await L2PSTransactionExecutor.getSubnetTransactions("s", 10, { afterId: 42 })

        expect(page).toEqual({ rows: [], nextCursor: 42, hasMore: false })
    })

    it("a full page says there is more only when a row exists past it", async () => {
        getMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }] as never)
        expect((await L2PSTransactionExecutor.getSubnetTransactions("s", 2, {})).hasMore).toBe(false)

        getMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }] as never)
        const page = await L2PSTransactionExecutor.getSubnetTransactions("s", 2, {})
        expect(page.hasMore).toBe(true)
        expect(page.rows).toHaveLength(2)
        expect(page.nextCursor).toBe(2)
    })
})

describe("recordTransaction with a hostile transaction", () => {
    const tx = (content: Record<string, unknown>, hash = "h") => ({ hash, content: { type: "native", from: "a", to: "b", ...content } }) as never

    it("surfaces a duplicate hash instead of swallowing it, so the caller can tell the history did not grow", async () => {
        save.mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint "UQ_hash"'), { code: "23505" }))

        await expect(L2PSTransactionExecutor.recordTransaction("s", tx({}), "", "e", 0, "pending", {})).rejects.toThrow(/duplicate key/)
    })

    it.each([["abc"], ["1e30"], [1.5], [{}], ["0x1g"], [Symbol.iterator]])(
        "an amount of %p is refused whole, not stored as something else",
        async amount => {
            await expect(
                L2PSTransactionExecutor.recordTransaction("s", tx({ amount }), "", "e", 0, "pending", {}),
            ).rejects.toThrow()
            expect(save).not.toHaveBeenCalled()
        },
    )

    it("stores a large amount exactly, past the double-precision range", async () => {
        const amount = "340282366920938463463374607431768211455"
        await L2PSTransactionExecutor.recordTransaction("s", tx({ amount }), "", "e", 0, "pending", {})

        expect(create.mock.calls[0][0].amount).toBe(BigInt(amount))
    })

    it("never stores the plaintext content unless the node is configured to", async () => {
        const content = { amount: 1, data: ["native", { message: "secret" }] }
        await L2PSTransactionExecutor.recordTransaction("s", tx(content), "", "e", 0, "pending", { c: 1 })
        expect(JSON.stringify(create.mock.calls[0][0])).not.toContain("secret")

        storePlaintext.value = true
        create.mockClear()
        await L2PSTransactionExecutor.recordTransaction("s", tx(content), "", "e", 0, "pending", { c: 1 })
        expect(JSON.stringify(create.mock.calls[0][0])).toContain("secret")
    })

    it("a missing ciphertext is stored as null, never as undefined", async () => {
        await L2PSTransactionExecutor.recordTransaction("s", tx({ amount: 1 }), "", "e", 0, "pending")
        expect(create.mock.calls[0][0].encrypted_payload).toBeNull()
    })
})
