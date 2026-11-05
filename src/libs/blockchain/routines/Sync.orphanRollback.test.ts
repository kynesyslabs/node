/**
 * Recovery from GCR state stamped for a block the chain does not hold. The
 * stamped transactions are undone by replaying their bodies in reverse,
 * which is only right when every stamped transaction applied. Under
 * `nonceIntegrity` a failed transaction is stamped too, its fee and nonce
 * charged and its other edits never applied, so such a block is left for a
 * resync instead.
 */

import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        warn: () => {},
        error: () => {},
        only: () => {},
        custom: () => {},
    },
}))

const { default: Chain } = await import("../chain")
const { default: HandleGCR } = await import("../gcr/handleGCR")
const { default: Mempool } = await import("../mempool")
const { default: Datasource } = await import("@/model/datasource")
const { cloneDefaultForkConfig } = await import("@/forks/forkConfig")
const { getSharedState } = await import("@/utilities/sharedState")
const { assertNoUnreconciledGcrState } = await import("./Sync")

const TIP = 20
const ORPHAN = TIP + 1
const stamped = [{ hash: "aa".repeat(32), block: ORPHAN }]

const queryBuilder: any = {
    select: () => queryBuilder,
    addSelect: () => queryBuilder,
    where: () => queryBuilder,
    getRawOne: async () => ({ max: ORPHAN }),
    getRawMany: async () => stamped,
}
const fakeDatasource = {
    getDataSource: () => ({
        getRepository: () => ({ createQueryBuilder: () => queryBuilder }),
    }),
}

const applyTransactions = spyOn(HandleGCR, "applyTransactions")
const deleteAssignedTxsForBlock = spyOn(HandleGCR, "deleteAssignedTxsForBlock")

function nonceIntegrity(height: number | null) {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.nonceIntegrity.activationHeight = height
}

beforeEach(() => {
    spyOn(Chain, "getLastBlockNumber").mockResolvedValue(TIP)
    spyOn(Datasource, "getInstance").mockResolvedValue(fakeDatasource as any)
    spyOn(Mempool, "getTransactionsByHashes").mockResolvedValue(
        stamped.map(s => ({
            hash: s.hash,
            content: { from_ed25519_address: "0x" + "11".repeat(32), nonce: 1, gcr_edits: [] },
        })) as any,
    )
    applyTransactions.mockReset()
    applyTransactions.mockResolvedValue({ successfulTxs: [], failedTxs: [], skippedTxs: [] } as any)
    deleteAssignedTxsForBlock.mockReset()
    deleteAssignedTxsForBlock.mockResolvedValue(1)
})

// In this order: a refused recovery latches the node for the process.
describe("orphaned GCR state", () => {
    it("is rolled back from the stamped bodies for a block applied before the fork", async () => {
        nonceIntegrity(null)

        await assertNoUnreconciledGcrState()

        expect(applyTransactions).toHaveBeenCalledTimes(1)
        expect(applyTransactions.mock.calls[0][1]).toBe(true)
        expect(deleteAssignedTxsForBlock).toHaveBeenCalledWith(ORPHAN)
    })

    it("is rolled back for the block applied on tip H when the fork activates at H + 1", async () => {
        nonceIntegrity(ORPHAN)

        await assertNoUnreconciledGcrState()

        expect(applyTransactions).toHaveBeenCalledTimes(1)
        expect(deleteAssignedTxsForBlock).toHaveBeenCalledWith(ORPHAN)
    })

    it("is left for a resync for a block applied under nonceIntegrity, changing nothing", async () => {
        nonceIntegrity(ORPHAN - 1)

        await expect(assertNoUnreconciledGcrState()).rejects.toThrow(/resynced/)

        expect(applyTransactions).not.toHaveBeenCalled()
        expect(deleteAssignedTxsForBlock).not.toHaveBeenCalled()
    })
})
