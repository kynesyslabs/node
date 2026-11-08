/**
 * GCR state stamped above the chain tip is undone from the mempool's copies of
 * its transactions, or not at all. The stamps are what finds the orphan again
 * after a restart, so writing some undos while keeping the stamps would undo
 * those transactions a second time on the next attempt.
 *
 * Replaying the bodies in reverse is only right when every stamped
 * transaction applied. Under `nonceIntegrity` a failed transaction is stamped
 * too, its fee and nonce charged and its other edits never applied, so such a
 * block is left for a resync instead.
 */

import { beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}))

const { default: Chain } = await import("../chain")
const { default: HandleGCR } = await import("../gcr/handleGCR")
const { default: Datasource } = await import("@/model/datasource")
const { default: Mempool } = await import("../mempool")
const { cloneDefaultForkConfig } = await import("@/forks/forkConfig")
const { getSharedState } = await import("@/utilities/sharedState")
const { assertNoUnreconciledGcrState, rollbackOrphanedGcrState } = await import("./Sync")

const TIP = 20
const ORPHAN = TIP + 1
const ORPHANS = [
    { hash: "tx-a", block: ORPHAN },
    { hash: "tx-b", block: ORPHAN },
    { hash: "tx-c", block: ORPHAN + 1 },
]
let stamped: { hash: string; block: number }[] = ORPHANS

/** What reached the database, in order, and whether it committed. */
let log: string[] = []
const em = { name: "em" }

const queryBuilder: any = {
    select: () => queryBuilder,
    addSelect: () => queryBuilder,
    where: () => queryBuilder,
    getRawOne: async () => ({ max: Math.max(...stamped.map(s => s.block)) }),
    getRawMany: async () => stamped,
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

function nonceIntegrity(height: number | null) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.nonceIntegrity.activationHeight = height
}

function bodies() {
    return stamped.map((s, nonce) => ({
        hash: s.hash,
        content: { from_ed25519_address: "ab".repeat(32), nonce, gcr_edits: [] },
    })) as any
}

beforeEach(() => {
    log = []
    stamped = ORPHANS
    nonceIntegrity(null)
    getSharedState.runMainLoop = true
    spyOn(Chain, "getLastBlockNumber").mockResolvedValue(TIP)
    spyOn(Chain, "getLastStoredBlockNumber").mockResolvedValue(TIP)
    spyOn(Datasource, "getInstance").mockResolvedValue(fakeDatasource as any)
    spyOn(Mempool, "getTransactionsByHashes").mockImplementation(async () => bodies())
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
    it("does not write an undo or delete stamps once shutdown starts", async () => {
        getSharedState.runMainLoop = false

        expect(await rollbackOrphanedGcrState(TIP)).toBe(false)
        expect(applyTransactions).not.toHaveBeenCalled()
        expect(deleteAssigned).not.toHaveBeenCalled()
        expect(log).toEqual([])
    })

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

// After the suite above, and in this order: a refused recovery latches the
// node for the process.
describe("orphaned GCR state and nonceIntegrity", () => {
    beforeEach(() => {
        stamped = [{ hash: "aa".repeat(32), block: ORPHAN }]
        applyTransactions.mockResolvedValue({
            successfulTxs: stamped.map(s => s.hash),
            failedTxs: [],
            skippedTxs: [],
            pending,
        } as any)
    })

    it("is rolled back from the stamped bodies for a block applied before the fork", async () => {
        nonceIntegrity(null)

        await assertNoUnreconciledGcrState()

        expect(applyTransactions).toHaveBeenCalledTimes(1)
        expect(applyTransactions.mock.calls[0][1]).toBe(true)
        expect(log).toEqual(["begin", "write", `delete ${ORPHAN}`, "commit", "afterCommit"])
    })

    it("is rolled back for the block applied on tip H when the fork activates at H + 1", async () => {
        nonceIntegrity(ORPHAN)

        await assertNoUnreconciledGcrState()

        expect(applyTransactions).toHaveBeenCalledTimes(1)
        expect(log).toEqual(["begin", "write", `delete ${ORPHAN}`, "commit", "afterCommit"])
    })

    it("is left for a resync for a block applied under nonceIntegrity, changing nothing", async () => {
        nonceIntegrity(ORPHAN - 1)

        await expect(assertNoUnreconciledGcrState()).rejects.toThrow(/resynced/)

        expect(applyTransactions).not.toHaveBeenCalled()
        expect(deleteAssigned).not.toHaveBeenCalled()
        expect(log).toEqual([])
    })
})
