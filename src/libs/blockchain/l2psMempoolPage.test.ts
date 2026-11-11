/**
 * The paged queue listing and the backlog summary issue bounded queries.
 */

import { describe, expect, it, jest } from "bun:test"
import { mockMempoolDeps } from "@/libs/blockchain/testSupport/mockMempoolDeps"

mockMempoolDeps()

const { default: L2PSMempool } = await import("./l2ps_mempool")

function recordingBuilder(result: { many?: unknown[]; raw?: unknown }) {
    const calls: Record<string, unknown[]> = {}
    const note = (name: string) => (...args: unknown[]) => {
        ;(calls[name] ??= []).push(args)
        return qb
    }
    const qb: any = {
        select: note("select"),
        addSelect: note("addSelect"),
        where: note("where"),
        andWhere: note("andWhere"),
        orderBy: note("orderBy"),
        addOrderBy: note("addOrderBy"),
        limit: note("limit"),
        getMany: async () => result.many ?? [],
        getRawOne: async () => result.raw,
    }
    return { qb, calls }
}

describe("getPageByUID", () => {
    it("selects identifying columns only and applies the limit in the query", async () => {
        const { qb, calls } = recordingBuilder({ many: [] })
        ;(L2PSMempool as any).repo = { createQueryBuilder: () => qb }

        await L2PSMempool.getPageByUID("subnet_a", { timestamp: 42 }, 1000)

        const columns = (calls.select[0] as string[][])[0]
        expect(columns).not.toContain("tx.encrypted_tx")
        expect(columns).not.toContain("tx.gcr_edits")
        expect(calls.limit).toEqual([[1000]])
        expect(calls.andWhere[0][1]).toEqual({ after: "42" })
    })

    it("with a hash in the cursor also matches rows sharing its timestamp that sort after it", async () => {
        const { qb, calls } = recordingBuilder({ many: [] })
        ;(L2PSMempool as any).repo = { createQueryBuilder: () => qb }

        await L2PSMempool.getPageByUID("subnet_a", { timestamp: 42, hash: "abc" }, 10)

        expect(String(calls.andWhere[0][0])).toContain("= CAST(:after AS BIGINT) AND tx.hash > :afterHash")
        expect(calls.andWhere[0][1]).toEqual({ after: "42", afterHash: "abc" })
        expect(calls.addOrderBy).toEqual([["tx.hash", "ASC"]])
    })

    it("treats a negative or fractional cursor as a safe integer", async () => {
        const { qb, calls } = recordingBuilder({ many: [] })
        ;(L2PSMempool as any).repo = { createQueryBuilder: () => qb }

        await L2PSMempool.getPageByUID("subnet_a", { timestamp: -5 }, 10)
        await L2PSMempool.getPageByUID("subnet_a", { timestamp: 7.9 }, 10)

        expect(calls.andWhere.map(args => (args[1] as any).after)).toEqual(["0", "7"])
    })
})

describe("getSummaryByUIDAndStatus", () => {
    it("returns the database's count and span", async () => {
        const { qb } = recordingBuilder({ raw: { count: "12", oldest: "5", newest: "9" } })
        ;(L2PSMempool as any).repo = { createQueryBuilder: () => qb }

        expect(await L2PSMempool.getSummaryByUIDAndStatus("subnet_a", "executed")).toEqual({
            count: 12,
            oldestTimestamp: "5",
            newestTimestamp: "9",
        })
    })
})

describe("countByUIDAndStatus", () => {
    it("asks the database for a plain count of the subnet's rows in that status", async () => {
        const count = jest.fn(async (..._args: unknown[]) => 7)
        ;(L2PSMempool as any).repo = { count }

        expect(await L2PSMempool.countByUIDAndStatus("subnet_a", "executed")).toBe(7)
        expect(count).toHaveBeenCalledWith({ where: { l2ps_uid: "subnet_a", status: "executed" } })
    })

    it("reaches the caller when the database cannot be queried", async () => {
        ;(L2PSMempool as any).repo = {
            count: async () => {
                throw new Error("connection lost")
            },
        }

        await expect(L2PSMempool.countByUIDAndStatus("subnet_a", "executed")).rejects.toThrow("connection lost")
    })
})

describe("getSummaryByUIDAndStatus failure", () => {
    it("reaches the caller instead of reading as an empty queue", async () => {
        ;(L2PSMempool as any).repo = {
            createQueryBuilder: () => {
                throw new Error("connection lost")
            },
        }

        await expect(L2PSMempool.getSummaryByUIDAndStatus("subnet_a", "executed")).rejects.toThrow("connection lost")
    })
})

describe("cleanupBatchedWithoutEdits", () => {
    it("deletes only rows whose ciphertext the history table holds, and counts the ones it keeps", async () => {
        const del = recordingBuilder({})
        ;(del.qb as any).delete = () => del.qb
        ;(del.qb as any).from = () => del.qb
        ;(del.qb as any).execute = async () => ({ affected: 3 })
        const kept = recordingBuilder({})
        ;(kept.qb as any).getCount = async () => 2
        let builders = 0
        ;(L2PSMempool as any).repo = { createQueryBuilder: () => (builders++ === 0 ? del.qb : kept.qb) }

        expect(await L2PSMempool.cleanupBatchedWithoutEdits(300_000)).toBe(3)

        const deleteClauses = del.calls.andWhere.map(args => String(args[0]))
        expect(deleteClauses.some(c => c.startsWith("EXISTS") && c.includes("l2ps_transactions") && c.includes("encrypted_payload IS NOT NULL"))).toBe(true)
        const keptClauses = kept.calls.andWhere.map(args => String(args[0]))
        expect(keptClauses.some(c => c.startsWith("NOT EXISTS") && c.includes("tx.original_hash"))).toBe(true)
    })
})

describe("getPageByUIDAndStatus", () => {
    it("pages in queue order and throws on a failed read instead of answering an empty page", async () => {
        const finds: any[] = []
        ;(L2PSMempool as any).repo = { find: async (options: unknown) => (finds.push(options), []) }
        await L2PSMempool.getPageByUIDAndStatus("subnet_a", "batched", 50, 100)
        expect(finds[0]).toMatchObject({
            where: { l2ps_uid: "subnet_a", status: "batched" },
            order: { timestamp: "ASC", hash: "ASC" },
            take: 50,
            skip: 100,
        })

        ;(L2PSMempool as any).repo = {
            find: async () => {
                throw new Error("connection terminated")
            },
        }
        await expect(L2PSMempool.getPageByUIDAndStatus("subnet_a", "batched", 50)).rejects.toThrow(
            "connection terminated",
        )
        // The lenient reader still answers [] for its other callers.
        expect(await L2PSMempool.getByUIDAndStatus("subnet_a", "batched", 50)).toEqual([])
    })
})

describe("setStatusBatch", () => {
    it("throws on a failed write instead of answering that no row changed", async () => {
        const updates: unknown[] = []
        ;(L2PSMempool as any).repo = {
            update: async (where: unknown, values: unknown) => (updates.push([where, values]), { affected: 2 }),
        }
        expect(await L2PSMempool.setStatusBatch(["a", "b"], "confirmed")).toBe(2)
        expect(updates).toHaveLength(1)

        ;(L2PSMempool as any).repo = {
            update: async () => {
                throw new Error("connection terminated")
            },
        }
        await expect(L2PSMempool.setStatusBatch(["a"], "confirmed")).rejects.toThrow("connection terminated")
        // The lenient writer still answers 0 for its other callers.
        expect(await L2PSMempool.updateStatusBatch(["a"], "confirmed")).toBe(0)
    })
})

describe("getSettleableHashes", () => {
    it("answers the rows the settlement loop can still settle, and throws on a failed read", async () => {
        const finds: any[] = []
        ;(L2PSMempool as any).repo = {
            find: async (options: unknown) => (finds.push(options), [{ hash: "a" }]),
        }
        expect(await L2PSMempool.getSettleableHashes(["a", "b"])).toEqual(new Set(["a"]))
        expect(JSON.stringify(finds[0].where.status)).toContain("deferred")
        expect(await L2PSMempool.getSettleableHashes([])).toEqual(new Set())
        expect(finds).toHaveLength(1)

        ;(L2PSMempool as any).repo = {
            find: async () => {
                throw new Error("connection terminated")
            },
        }
        await expect(L2PSMempool.getSettleableHashes(["a"])).rejects.toThrow("connection terminated")
    })
})
