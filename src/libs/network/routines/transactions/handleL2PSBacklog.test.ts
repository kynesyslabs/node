/**
 * Submitting a transaction to a subnet whose queue is full.
 *
 * Both the RPC and the OmniProtocol submit opcode end up here, so a refusal
 * has to come before any decrypt or write.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const admit = jest.fn()
const addTransaction = jest.fn(async (..._args: unknown[]) => ({ success: true }))
const getL2PS = jest.fn(async (..._args: unknown[]) => ({}))

mock.module("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
mock.module("src/libs/blockchain/transaction", () => ({ __esModule: true, default: {} }))
mock.module("../../server_rpc", () => ({
    emptyResponse: { result: 200, response: "", require_reply: false, extra: null },
}))
mock.module("@/libs/l2ps/parallelNetworks", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getL2PS, loadL2PS: getL2PS }) },
}))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({ __esModule: true, default: { addTransaction } }))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/balanceCheck", () => ({ checkInnerTxBalance: async () => null }))
mock.module("@/libs/l2ps/executedBacklogGuard", () => ({
    __esModule: true,
    L2PS_BACKLOG_FULL: "L2PS_BACKLOG_FULL",
    getExecutedBacklogGuard: () => ({ admit }),
}))
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { default: handleL2PS } = await import("./handleL2PS")

const tx = { hash: "a".repeat(64), content: { data: ["l2psEncryptedTx", { l2ps_uid: "subnet_a", original_hash: "0xo" }] } } as any

beforeEach(() => {
    admit.mockReset()
    addTransaction.mockClear()
    getL2PS.mockClear()
})

describe("handleL2PS with a full subnet queue", () => {
    it("answers 429 with the backlog code and writes nothing", async () => {
        admit.mockResolvedValue({ admitted: false, count: 50_000, cap: 50_000, retryAfterMs: 10_000 })

        const response = await handleL2PS(tx)

        expect(response.result).toBe(429)
        expect(String(response.extra)).toContain("L2PS_BACKLOG_FULL")
        expect(admit).toHaveBeenCalledWith("subnet_a")
        expect(addTransaction).not.toHaveBeenCalled()
    })

    it("goes on to decrypt and validate while there is room", async () => {
        admit.mockResolvedValue({ admitted: true })
        // The stub subnet has no real decrypt, so the request fails later, and not with 429.
        const response = await handleL2PS(tx)

        expect(response.result).not.toBe(429)
    })

    it("refuses a malformed outer hash before the backlog or the network is consulted", async () => {
        for (const hash of ["enc-1", "\u{1F600}".repeat(32), "A".repeat(64), undefined]) {
            const response = await handleL2PS({ ...tx, hash })

            expect(response.result).toBe(400)
            expect(String(response.extra)).toContain("hash")
        }
        expect(admit).not.toHaveBeenCalled()
        expect(getL2PS).not.toHaveBeenCalled()
        expect(addTransaction).not.toHaveBeenCalled()
    })
})
