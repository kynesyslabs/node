/**
 * Submitting a transaction to a subnet whose queue is full.
 *
 * Both the RPC and the OmniProtocol submit opcode end up here. The refusal is
 * cheap and comes before any decrypt; the slot is only taken for a transaction
 * that decrypted, verified and is not a duplicate; and the answer says when to
 * retry without saying how full the queue is.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const check = jest.fn()
const claim = jest.fn()
const release = jest.fn()
const guard = { check, claim, release, retryAfterMs: 10_000 }
const execute = jest.fn(async (..._args: unknown[]): Promise<any> => ({ success: true, gcr_edits: [] }))
const addTransaction = jest.fn(async (..._args: unknown[]): Promise<{ success: boolean; error?: string }> => ({ success: true }))
const existsByOriginalHash = jest.fn(async (..._args: unknown[]) => false)
const decryptTx = jest.fn()
const getL2PS = jest.fn(async (..._args: unknown[]) => ({ decryptTx }))
const confirmTx = jest.fn(async (..._args: unknown[]) => ({ success: true }))

mock.module("src/libs/blockchain/chain", () => ({ __esModule: true, default: {} }))
mock.module("src/libs/blockchain/transaction", () => ({ __esModule: true, default: { confirmTx } }))
mock.module("../../server_rpc", () => ({
    emptyResponse: { result: 200, response: "", require_reply: false, extra: null },
}))
mock.module("@/libs/l2ps/parallelNetworks", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getL2PS, loadL2PS: getL2PS }) },
}))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: {
        addTransaction,
        existsByOriginalHash,
        updateStatus: async () => true,
        updateGCREdits: async () => true,
    },
}))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    L2PS_TX_FEE: 1,
    default: {
        hasExecuted: async () => false,
        execute,
        recordTransaction: async () => undefined,
    },
}))
mock.module("@/libs/l2ps/balanceCheck", () => ({ checkInnerTxBalance: async () => null }))
mock.module("@/libs/l2ps/executedBacklogGuard", () => ({
    __esModule: true,
    L2PS_BACKLOG_FULL: "L2PS_BACKLOG_FULL",
    backlogFullMessage: (ms: number) => `L2PS_BACKLOG_FULL: retryAfterMs=${ms}`,
    getExecutedBacklogGuard: () => guard,
}))
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { default: handleL2PS } = await import("./handleL2PS")

const tx = {
    hash: "a".repeat(64),
    content: { data: ["l2psEncryptedTx", { l2ps_uid: "subnet_a", original_hash: "orig" }] },
} as any

beforeEach(() => {
    check.mockReset()
    claim.mockReset()
    release.mockReset()
    execute.mockReset()
    execute.mockResolvedValue({ success: true, gcr_edits: [] })
    check.mockResolvedValue({ admitted: true, count: 1, cap: 50_000, retryAfterMs: 10_000 })
    claim.mockReturnValue(true)
    addTransaction.mockReset()
    addTransaction.mockResolvedValue({ success: true })
    existsByOriginalHash.mockReset()
    existsByOriginalHash.mockResolvedValue(false)
    getL2PS.mockClear()
    decryptTx.mockReset()
    decryptTx.mockResolvedValue({ hash: "orig", content: { from: "alice" } })
    confirmTx.mockClear()
})

describe("handleL2PS with a full subnet queue", () => {
    it("answers 429 with the code and the retry time, and nothing else about the queue", async () => {
        check.mockResolvedValue({ admitted: false, count: 50_000, cap: 50_000, retryAfterMs: 10_000 })

        const response = await handleL2PS(tx)

        expect(response.result).toBe(429)
        expect(response.extra).toBe("L2PS_BACKLOG_FULL: retryAfterMs=10000")
        expect(String(response.extra)).not.toContain("50000")
        expect(decryptTx).not.toHaveBeenCalled()
        expect(addTransaction).not.toHaveBeenCalled()
    })

    it("answers 429 when the subnet fills between the check and the claim, and stores nothing", async () => {
        claim.mockReturnValue(false)

        const response = await handleL2PS(tx)

        expect(response.result).toBe(429)
        expect(response.extra).toBe("L2PS_BACKLOG_FULL: retryAfterMs=10000")
        expect(addTransaction).not.toHaveBeenCalled()
    })

    it("takes one slot for a valid new transaction", async () => {
        const response = await handleL2PS(tx)

        expect(response.result).toBe(200)
        expect(claim).toHaveBeenCalledTimes(1)
        expect(claim).toHaveBeenCalledWith("subnet_a")
        expect(addTransaction).toHaveBeenCalledTimes(1)
    })

    it("gives the slot back once the row is executed", async () => {
        expect((await handleL2PS(tx)).result).toBe(200)

        expect(release).toHaveBeenCalledTimes(1)
        expect(release).toHaveBeenCalledWith("subnet_a")
    })

    it("gives the slot back when the mempool refuses the row", async () => {
        addTransaction.mockResolvedValue({ success: false, error: "db down" })

        expect((await handleL2PS(tx)).result).toBe(500)
        expect(release).toHaveBeenCalledTimes(1)
    })

    it("gives the slot back when execution throws", async () => {
        execute.mockRejectedValue(new Error("boom"))

        expect((await handleL2PS(tx)).result).toBe(500)
        expect(release).toHaveBeenCalledTimes(1)
    })

    it("gives the slot back when execution reports failure", async () => {
        execute.mockResolvedValue({ success: false, message: "insufficient balance" })

        expect((await handleL2PS(tx)).result).toBe(400)
        expect(release).toHaveBeenCalledTimes(1)
    })

    it("releases nothing when no slot was taken", async () => {
        claim.mockReturnValue(false)

        expect((await handleL2PS(tx)).result).toBe(429)
        expect(release).not.toHaveBeenCalled()
    })

    it("takes no slot for requests that fail to decrypt, fail verification or repeat a transaction", async () => {
        decryptTx.mockRejectedValue(new Error("bad ciphertext"))
        for (let i = 0; i < 20; i++) expect((await handleL2PS(tx)).result).toBe(400)

        decryptTx.mockResolvedValue({ hash: "orig", content: { from: "alice" } })
        confirmTx.mockResolvedValue({ success: false })
        for (let i = 0; i < 20; i++) expect((await handleL2PS(tx)).result).toBe(400)

        confirmTx.mockResolvedValue({ success: true })
        existsByOriginalHash.mockResolvedValue(true)
        for (let i = 0; i < 20; i++) expect((await handleL2PS(tx)).result).toBe(409)

        expect(claim).not.toHaveBeenCalled()
    })

    it("refuses a malformed outer hash before the backlog or the network is consulted", async () => {
        for (const hash of ["enc-1", "\u{1F600}".repeat(32), "A".repeat(64), undefined]) {
            const response = await handleL2PS({ ...tx, hash })

            expect(response.result).toBe(400)
            expect(String(response.extra)).toContain("hash")
        }
        expect(check).not.toHaveBeenCalled()
        expect(getL2PS).not.toHaveBeenCalled()
        expect(addTransaction).not.toHaveBeenCalled()
    })
})
