/**
 * The paged queue listing and the backlog summary issue bounded queries.
 */

import { describe, expect, it, jest } from "bun:test"

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: async () => ({ getDataSource: () => ({}) }) },
}))
jest.mock("@/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
jest.mock("@/libs/consensus/v2/types/secretaryManager", () => ({
    __esModule: true,
    default: { getInstance: () => ({}) },
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

        await L2PSMempool.getPageByUID("subnet_a", 42, 1000)

        const columns = (calls.select[0] as string[][])[0]
        expect(columns).not.toContain("tx.encrypted_tx")
        expect(columns).not.toContain("tx.gcr_edits")
        expect(calls.limit).toEqual([[1000]])
        expect(calls.andWhere[0][1]).toEqual({ after: "42" })
    })

    it("treats a negative or fractional cursor as a safe integer", async () => {
        const { qb, calls } = recordingBuilder({ many: [] })
        ;(L2PSMempool as any).repo = { createQueryBuilder: () => qb }

        await L2PSMempool.getPageByUID("subnet_a", -5, 10)
        await L2PSMempool.getPageByUID("subnet_a", 7.9, 10)

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
