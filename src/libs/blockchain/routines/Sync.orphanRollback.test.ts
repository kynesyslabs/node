/**
 * GCR state stamped above the chain tip is undone from the mempool's copies of
 * its transactions, or not at all. The stamps are what finds the orphan again
 * after a restart, so writing some undos while keeping the stamps would undo
 * those transactions a second time on the next attempt.
 */

import { beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { default: HandleGCR } = await import("../gcr/handleGCR")
const { default: Datasource } = await import("@/model/datasource")
const { default: Mempool } = await import("../mempool")
const { rollbackOrphanedGcrState } = await import("./Sync")

const TIP = 20
const ORPHANS = [
    { hash: "tx-a", block: 21 },
    { hash: "tx-b", block: 21 },
    { hash: "tx-c", block: 22 },
]

/** What reached the database, in order, and whether it committed. */
let log: string[] = []
const em = { name: "em" }
const queryBuilder: any = {
    select: () => queryBuilder,
    addSelect: () => queryBuilder,
    where: () => queryBuilder,
    getRawMany: async () => ORPHANS,
}
const fakeDatasource = {
    getDataSource: () => ({
        getRepository: () => ({ createQueryBuilder: () => queryBuilder }),
        transaction: async (work: (m: unknown) => Promise<void>) => {
            log.push("begin")
            await work(em)
            log.push("commit")
        },
    }),
}

const applyTransactions = spyOn(HandleGCR, "applyTransactions")
const deleteAssigned = spyOn(HandleGCR, "deleteAssignedTxsForBlock")
const pending = {
    write: jest.fn(async (m: unknown) => {
        log.push(m === em ? "write" : "write outside the transaction")
    }),
    afterCommit: jest.fn(async () => {
        log.push("afterCommit")
    }),
}

beforeEach(() => {
    log = []
    spyOn(Datasource, "getInstance").mockResolvedValue(fakeDatasource as any)
    spyOn(Mempool, "getTransactionsByHashes").mockResolvedValue(
        ORPHANS.map((o, nonce) => ({ hash: o.hash, content: { from_ed25519_address: "ab".repeat(32), nonce } })) as any,
    )
    applyTransactions.mockReset()
    deleteAssigned.mockReset()
    deleteAssigned.mockImplementation((async (block: number, m: unknown) => {
        log.push(m === em ? `delete ${block}` : `delete ${block} outside the transaction`)
        return 1
    }) as any)
    pending.write.mockClear()
    pending.afterCommit.mockClear()
})

describe("rolling back orphaned GCR state", () => {
    it("writes the undos and drops the stamps in one transaction when every rollback applies", async () => {
        applyTransactions.mockResolvedValue({
            successfulTxs: ORPHANS.map(o => o.hash),
            failedTxs: [],
            skippedTxs: [],
            pending,
        } as any)

        expect(await rollbackOrphanedGcrState(TIP)).toBe(true)

        const [, isRollback, , options] = applyTransactions.mock.calls[0] as any[]
        expect(isRollback).toBe(true)
        expect(options).toEqual({ defer: true })
        expect(log).toEqual(["begin", "write", "delete 21", "delete 22", "commit", "afterCommit"])
    })

    it("writes nothing and keeps the stamps when one rollback is refused", async () => {
        applyTransactions.mockResolvedValue({
            successfulTxs: ["tx-a", "tx-c"],
            failedTxs: ["tx-b"],
            skippedTxs: [],
            pending,
        } as any)

        expect(await rollbackOrphanedGcrState(TIP)).toBe(false)
        // Deferred, so the undos that did apply were never written either.
        expect((applyTransactions.mock.calls[0] as any[])[3]).toEqual({ defer: true })
        expect(log).toEqual([])
        expect(pending.afterCommit).not.toHaveBeenCalled()
    })

    it("keeps everything when a body is missing from the mempool", async () => {
        spyOn(Mempool, "getTransactionsByHashes").mockResolvedValue([{ hash: "tx-a" }] as any)

        expect(await rollbackOrphanedGcrState(TIP)).toBe(false)
        expect(applyTransactions).not.toHaveBeenCalled()
        expect(log).toEqual([])
    })
})
