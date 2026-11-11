/**
 * Member admission of an L2PS transfer under `l2psSettlement`: the transfer
 * must carry its settlement opening (the old format is refused with a clear
 * error), its commitment must open, the sender must have signed it for this
 * chain and subnet, the fee must reach the native transfer fee and the nonce
 * must be unspent. An admitted transfer is queued without running the
 * executor, whose edits fed the local proof path the fork turns off.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"

const check = jest.fn()
const claim = jest.fn()
const release = jest.fn()
const settle = jest.fn()
const guard = { check, claim, release, settle, retryAfterMs: 10_000 }
const updateStatus = jest.fn(async (..._args: unknown[]) => true)
const execute = jest.fn(async (..._args: unknown[]): Promise<any> => ({ success: true, gcr_edits: [] }))
const addTransaction = jest.fn(async (..._args: unknown[]): Promise<{ success: boolean; error?: string }> => ({ success: true }))
const existsByOriginalHash = jest.fn(async (..._args: unknown[]) => false)
const decryptTx = jest.fn()
const getL2PS = jest.fn(async (..._args: unknown[]) => ({ decryptTx }))
const confirmTx = jest.fn(async (..._args: unknown[]) => ({ success: true }))
const recordTransaction = jest.fn(async (..._args: unknown[]): Promise<void> => undefined)
const updateTransactionStatus = jest.fn(async (..._args: unknown[]): Promise<void> => undefined)
/** History rows of the sender's queued transfers; each envelope decrypts to `__inner`. */
let unsettled: { l2ps_uid: string; encrypted_hash: string; encrypted_payload: { __inner: unknown } }[] = []

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
        updateStatus,
        updateGCREdits: async () => true,
    },
}))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    L2PS_TX_FEE: 1,
    default: {
        hasExecuted: async () => false,
        execute,
        recordTransaction,
        updateTransactionStatus,
        // As the query reads them: filtered by subnet only when given one.
        getUnsettledBySender: async (...args: unknown[]) =>
            unsettled.filter(row => args.length < 4 || row.l2ps_uid === args[0]),
    },
}))
const checkInnerTxBalance = jest.fn(async (..._args: unknown[]): Promise<string | null> => null)
mock.module("@/libs/l2ps/balanceCheck", () => ({ checkInnerTxBalance }))
let tipAccounts = new Map<string, { balance: bigint; nonce: bigint }>()
mock.module("@/libs/l2ps/settlement/tipState", () => ({
    readTipAccounts: async (accounts: Iterable<string>) => {
        const out = new Map<string, { balance: bigint; nonce: bigint }>()
        for (const a of accounts) out.set(a, tipAccounts.get(a) ?? { balance: 0n, nonce: 0n })
        return out
    },
}))
mock.module("@/libs/l2ps/executedBacklogGuard", () => ({
    __esModule: true,
    L2PS_BACKLOG_FULL: "L2PS_BACKLOG_FULL",
    backlogFullMessage: (ms: number) => `L2PS_BACKLOG_FULL: retryAfterMs=${ms}`,
    getExecutedBacklogGuard: () => guard,
}))
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("@/utilities/logger", () => ({ __esModule: true, default: logger }))

/** Everything logged above debug, as one string. */
const loudLogs = () =>
    [logger.info, logger.warn, logger.warning, logger.error, logger.only]
        .flatMap(fn => fn.mock.calls.flat())
        .map(String)
        .join("\n")

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { innerTx, key, signedTransfer } from "@/libs/l2ps/settlement/__fixtures__/settlementKit"
import { MAX_NONCE_AHEAD, SETTLEMENT_ENVELOPE_MAX_BYTES } from "@/libs/l2ps/settlement/transfer"

const { default: handleL2PS } = await import("./handleL2PS")

const OS = 1_000_000_000n
const FEE = 3n * OS
const ALICE = key(1)
const BOB = key(2)
const UID = "vector_subnet"

const tx = {
    hash: "a".repeat(64),
    content: { data: ["l2psEncryptedTx", { l2ps_uid: UID, original_hash: "orig" }] },
} as any

const saved = {
    forkConfig: getSharedState.forkConfig,
    lastBlockNumber: getSharedState.lastBlockNumber,
    chainId: getSharedState.chainId,
    networkFee: getSharedState.networkFee,
    rpcFee: getSharedState.rpcFee,
    additionalFee: getSharedState.additionalFee,
}

function decrypted(t: ReturnType<typeof signedTransfer>, mutate?: (inner: any) => void) {
    const inner = innerTx(t, UID) as any
    inner.hash = "orig"
    mutate?.(inner)
    decryptTx.mockImplementation(async (envelope: any) => envelope?.__inner ?? inner)
}

/** Records `t` as already queued here for its sender, as the history holds it. */
function queued(t: ReturnType<typeof signedTransfer>, uid = UID) {
    unsettled.push({ l2ps_uid: uid, encrypted_hash: t.txHash, encrypted_payload: { __inner: innerTx(t, uid) } })
}

const transfer = (over: Partial<Parameters<typeof signedTransfer>[0]> = {}) =>
    signedTransfer({ from: ALICE, to: BOB.account, amount: 5n * OS, fee: FEE, nonce: 5n, l2psUid: UID, ...over })

beforeEach(() => {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.l2psSettlement.activationHeight = 0
    getSharedState.lastBlockNumber = 100
    getSharedState.chainId = 4242
    getSharedState.networkFee = 1
    getSharedState.rpcFee = 1
    getSharedState.additionalFee = 1
    tipAccounts = new Map([[ALICE.account, { balance: 100n * OS, nonce: 4n }]])
    unsettled = []
    check.mockResolvedValue({ admitted: true, count: 1, cap: 50_000, retryAfterMs: 10_000 })
    claim.mockReturnValue(true)
    execute.mockReset()
    execute.mockResolvedValue({ success: true, gcr_edits: [] })
    addTransaction.mockReset()
    addTransaction.mockResolvedValue({ success: true })
    updateStatus.mockReset()
    updateStatus.mockResolvedValue(true)
    existsByOriginalHash.mockResolvedValue(false)
    recordTransaction.mockReset()
    recordTransaction.mockResolvedValue(undefined)
    updateTransactionStatus.mockReset()
    updateTransactionStatus.mockResolvedValue(undefined)
    settle.mockClear()
    for (const fn of Object.values(logger)) fn.mockClear()
})

afterEach(() => {
    Object.assign(getSharedState, saved)
})

describe("handleL2PS under l2psSettlement", () => {
    it("admits a signed settlement transfer and queues it without running the executor", async () => {
        decrypted(transfer())

        const response = await handleL2PS(tx)

        expect(response.result).toBe(200)
        expect(addTransaction).toHaveBeenCalledTimes(1)
        expect(execute).not.toHaveBeenCalled()
    })

    it("refuses a transfer whose history row cannot be written, so none is queued uncounted", async () => {
        decrypted(transfer())
        recordTransaction.mockRejectedValue(new Error("connection terminated"))

        const response = await handleL2PS(tx)

        expect(response.result).toBe(500)
        expect(updateStatus.mock.calls.map(call => call[1])).toEqual(["failed"])
        expect(settle).not.toHaveBeenCalled()
    })

    it("records the history before queuing, and refuses a transfer it cannot queue", async () => {
        decrypted(transfer())
        const order: string[] = []
        recordTransaction.mockImplementation(async () => void order.push("history"))
        updateStatus.mockImplementation(async (_hash, status) => (order.push(String(status)), status !== "executed"))

        const response = await handleL2PS(tx)

        expect(response.result).toBe(500)
        expect(order).toEqual(["history", "executed", "failed"])
        expect(updateTransactionStatus.mock.calls[0][1]).toBe("failed")
        expect(settle).not.toHaveBeenCalled()
    })

    it("refuses the format before the fork with an error that says to update the SDK", async () => {
        decrypted(transfer(), inner => delete inner.content.data[1].settlement)

        const response = await handleL2PS(tx)

        expect(response.result).toBe(400)
        expect(JSON.stringify(response)).toContain("old-format L2PS transfer")
        expect(JSON.stringify(response)).toContain("update the SDK")
        expect(addTransaction).not.toHaveBeenCalled()
    })

    it("refuses a commitment that does not open to the transfer", async () => {
        decrypted(transfer(), inner => (inner.content.data[1].args[1] = (6n * OS).toString()))
        const response = await handleL2PS(tx)
        expect(response.result).toBe(400)
        expect(JSON.stringify(response)).toContain("does not open")
    })

    it("refuses a signature by another key", async () => {
        const t = transfer()
        t.signature = transfer({ from: BOB }).signature
        decrypted(t)
        const response = await handleL2PS(tx)
        expect(response.result).toBe(400)
        expect(JSON.stringify(response)).toContain("signature does not verify")
    })

    it("refuses a fee below the native transfer fee", async () => {
        decrypted(transfer({ fee: FEE - 1n }))
        const response = await handleL2PS(tx)
        expect(response.result).toBe(400)
        expect(JSON.stringify(response)).toContain("below the native transfer fee")
    })

    it("refuses a nonce the account already spent on L1", async () => {
        decrypted(transfer({ nonce: 4n }))
        const response = await handleL2PS(tx)
        expect(response.result).toBe(400)
        expect(JSON.stringify(response)).toContain("already spent")
    })

    it("refuses a sender that cannot pay amount and fee at the tip", async () => {
        tipAccounts.set(ALICE.account, { balance: 5n * OS + FEE - 1n, nonce: 4n })
        decrypted(transfer())
        const response = await handleL2PS(tx)
        expect(response.result).toBe(400)
        expect(JSON.stringify(response)).toContain("Insufficient balance")
        // The amount is private to the subnet: the reason goes back to the
        // sender and to debug only.
        expect(loudLogs()).not.toContain((5n * OS + FEE).toString())
        expect(loudLogs()).not.toContain("Insufficient balance")
    })

    it("admits a transfer queued behind others while the balance covers all of them", async () => {
        queued(transfer({ nonce: 5n }))
        queued(transfer({ nonce: 6n }))
        decrypted(transfer({ nonce: 7n }))
        const response = await handleL2PS(tx)
        expect(response.result).toBe(200)
    })

    it("refuses a nonce more than two batches past the account nonce", async () => {
        decrypted(transfer({ nonce: 4n + MAX_NONCE_AHEAD + 1n }))
        const response = await handleL2PS(tx)
        expect(response.result).toBe(400)
        expect(JSON.stringify(response)).toContain(`more than ${MAX_NONCE_AHEAD} past the account nonce`)
        expect(addTransaction).not.toHaveBeenCalled()

        decrypted(transfer({ nonce: 4n + MAX_NONCE_AHEAD }))
        expect((await handleL2PS(tx)).result).toBe(200)
    })

    it("refuses a second transfer with a nonce already queued for the sender", async () => {
        queued(transfer({ nonce: 5n, amount: 1n }))
        decrypted(transfer({ nonce: 5n }))
        const response = await handleL2PS(tx)
        expect(response.result).toBe(400)
        expect(JSON.stringify(response)).toContain("already queued")
    })

    it("counts the sender's transfers queued in its other subnets, which spend the same L1 nonce and balance", async () => {
        const OTHER = "other_subnet"
        queued(transfer({ nonce: 5n, amount: 1n, l2psUid: OTHER }), OTHER)
        decrypted(transfer({ nonce: 5n }))
        const response = await handleL2PS(tx)
        expect(response.result).toBe(400)
        expect(JSON.stringify(response)).toContain("already queued")
        expect(getL2PS.mock.calls.map(call => call[0])).toContain(OTHER)
    })

    it("refuses a transfer the balance covers only without the sender's queued transfers", async () => {
        // 100 OS: two queued transfers take 2 x (45 + 3), this one needs 5 + 3 more.
        queued(transfer({ nonce: 5n, amount: 45n * OS }))
        queued(transfer({ nonce: 6n, amount: 45n * OS }))
        decrypted(transfer({ nonce: 7n }))
        const response = await handleL2PS(tx)
        expect(response.result).toBe(400)
        expect(JSON.stringify(response)).toContain("Insufficient balance")
        expect(JSON.stringify(response)).toContain("queued transfers")
        expect(addTransaction).not.toHaveBeenCalled()
    })

    it("counts no queued transfer whose nonce L1 already spent", async () => {
        queued(transfer({ nonce: 3n, amount: 90n * OS }))
        decrypted(transfer())
        expect((await handleL2PS(tx)).result).toBe(200)
    })

    it("logs no amount above debug when the old path refuses a balance", async () => {
        getSharedState.forkConfig.l2psSettlement.activationHeight = null
        decrypted(transfer(), inner => delete inner.content.data[1].settlement)
        checkInnerTxBalance.mockResolvedValueOnce("Insufficient balance: need 8000000000 (5 + 3 fee) but have 7")

        const response = await handleL2PS(tx)

        expect(response.result).toBe(400)
        expect(loudLogs()).not.toContain("8000000000")
        expect(loudLogs()).not.toContain("Insufficient balance")
    })

    it("keeps the old path before the fork", async () => {
        getSharedState.forkConfig.l2psSettlement.activationHeight = null
        decrypted(transfer(), inner => delete inner.content.data[1].settlement)

        const response = await handleL2PS(tx)

        expect(response.result).toBe(200)
        expect(execute).toHaveBeenCalledTimes(1)
    })

    it("refuses an envelope too large for any batch before it looks up, counts or decrypts anything", async () => {
        decrypted(transfer())
        decryptTx.mockClear()
        getL2PS.mockClear()
        check.mockClear()
        const big = { ...tx, content: { ...tx.content, padding: "x".repeat(SETTLEMENT_ENVELOPE_MAX_BYTES) } }

        const response = await handleL2PS(big)

        expect(response.result).toBe(400)
        expect(String(response.extra ?? response.response)).toContain("a settlement batch can carry")
        expect(getL2PS).not.toHaveBeenCalled()
        expect(check).not.toHaveBeenCalled()
        expect(decryptTx).not.toHaveBeenCalled()
    })
})
