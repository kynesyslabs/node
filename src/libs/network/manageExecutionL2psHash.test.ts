/**
 * The execution entry point hands L2PS bundles to the same handler, so a
 * malformed outer hash is refused there too.
 */

import { describe, expect, it, jest, mock } from "bun:test"

const addTransaction = jest.fn(async (..._args: unknown[]) => ({ success: true }))
const getL2PS = jest.fn(async (..._args: unknown[]) => ({}))

mock.module("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
mock.module("src/libs/blockchain/transaction", () => ({ __esModule: true, default: {} }))
mock.module("./server_rpc", () => ({
    emptyResponse: { result: 200, response: "", require_reply: false, extra: null },
}))
mock.module("src/libs/network/securityModule", () => ({}))
mock.module("@/libs/l2ps/parallelNetworks", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getL2PS, loadL2PS: getL2PS }) },
}))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({ __esModule: true, default: { addTransaction } }))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({ __esModule: true, L2PS_TX_FEE: 1, default: {} }))
mock.module("@/libs/l2ps/balanceCheck", () => ({ checkInnerTxBalance: async () => null }))
mock.module("@/libs/l2ps/executedBacklogGuard", () => ({
    __esModule: true,
    L2PS_BACKLOG_FULL: "L2PS_BACKLOG_FULL",
    getExecutedBacklogGuard: () => ({ check: async () => ({ admitted: true }), admit: async () => ({ admitted: true }) }),
}))
mock.module("./endpointHandlers", async () => ({
    __esModule: true,
    default: { handleL2PS: (await import("./routines/transactions/handleL2PS")).default },
}))
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { manageExecution } = await import("./manageExecution")

describe("manageExecution with an L2PS bundle", () => {
    it("refuses a malformed outer hash and stores nothing", async () => {
        const data = {
            hash: "enc-1",
            content: { data: ["l2psEncryptedTx", { l2ps_uid: "subnet_a", original_hash: "0xo" }] },
        }
        for (const type of ["l2ps", "l2psEncryptedTx"]) {
            const response = await manageExecution({ type, data } as any, "sender")
            expect(response.result).toBe(400)
        }
        expect(getL2PS).not.toHaveBeenCalled()
        expect(addTransaction).not.toHaveBeenCalled()
    })
})
