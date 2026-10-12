import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

// A synced block whose txs do not all apply must not be inserted, and the txs that did apply
// must be rolled back so a re-fetch of the same block does not apply them twice.

const logMock = {
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), warn: jest.fn(), error: jest.fn() },
}
jest.mock("src/utilities/logger", () => logMock)
jest.mock("@/utilities/logger", () => logMock)
const sharedState = { __esModule: true, getSharedState: { inGcrApply: false, lastBlockNumber: 0, lastBlockHash: "" } }
jest.mock("src/utilities/sharedState", () => sharedState)
jest.mock("@/utilities/sharedState", () => sharedState)
jest.mock("src/libs/peer/Peer", () => ({ __esModule: true, default: { fromIPeer: jest.fn() } }))
jest.mock("src/libs/peer/PeerManager", () => ({
    __esModule: true,
    default: { getInstance: () => ({ getPeers: () => [], getAll: () => [], addPeer: jest.fn() }) },
}))
jest.mock("src/libs/blockchain/block", () => ({ __esModule: true, default: class {} }))
const insertBlock = jest.fn(async () => undefined)
const insertTransactionsFromSync = jest.fn(async () => true)
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { insertBlock, insertTransactionsFromSync },
}))
jest.mock("@/errors", () => ({
    __esModule: true,
    BlockNotFoundError: class extends Error {},
    PeerUnreachableError: class extends Error {},
    TimeoutError: class extends Error {},
    handleError: jest.fn(),
}))
const applyTransactions = jest.fn<(txs: any[], isRollback: boolean) => Promise<any>>()
jest.mock("src/libs/blockchain/gcr/handleGCR", () => ({ __esModule: true, default: { applyTransactions } }))
jest.mock("@/libs/l2ps/L2PSConcurrentSync", () => ({
    __esModule: true,
    discoverL2PSParticipants: jest.fn(),
    syncL2PSWithPeer: jest.fn(),
    exchangeL2PSParticipation: jest.fn(),
}))
jest.mock("@/libs/communications/broadcastManager", () => ({
    __esModule: true,
    BroadcastManager: { broadcastOurSyncData: jest.fn() },
}))
jest.mock("@/utilities/waiter", () => ({ __esModule: true, Waiter: { keys: {}, wait: jest.fn() } }))

let syncBlock: typeof import("src/libs/blockchain/routines/Sync")["syncBlock"]

beforeAll(async () => {
    syncBlock = (await import("src/libs/blockchain/routines/Sync")).syncBlock
})

const txA = { hash: "0xa", content: { gcr_edits: [] } } as any
const txB = { hash: "0xb", content: { gcr_edits: [] } } as any
const txC = { hash: "0xc", content: { gcr_edits: [] } } as any
const block = {
    number: 5,
    hash: "0xblock",
    content: { peerlist: [], ordered_transactions: ["0xa", "0xb", "0xc"] },
} as any
const peer = { longCall: jest.fn(async () => ({ result: 200, response: [txA, txB, txC] })) } as any

beforeEach(() => {
    applyTransactions.mockReset()
    insertBlock.mockClear()
    insertTransactionsFromSync.mockClear()
})

describe("syncBlock when a tx fails to apply", () => {
    it("does not insert the block and rolls back the applied txs, newest first", async () => {
        applyTransactions.mockImplementation(async (txs, isRollback) =>
            isRollback
                ? { successfulTxs: txs.map(t => t.hash), failedTxs: [] }
                : { successfulTxs: ["0xa", "0xc"], failedTxs: ["0xb"] },
        )

        const ok = await syncBlock(block, peer)

        expect(ok).toBe(false)
        expect(insertBlock).not.toHaveBeenCalled()
        expect(insertTransactionsFromSync).not.toHaveBeenCalled()
        expect(applyTransactions).toHaveBeenCalledTimes(2)
        const [undoTxs, isRollback] = applyTransactions.mock.calls[1]
        expect(isRollback).toBe(true)
        expect(undoTxs.map((t: any) => t.hash)).toEqual(["0xc", "0xa"])
    })

    it("inserts the block when every tx applies", async () => {
        applyTransactions.mockResolvedValue({ successfulTxs: ["0xa", "0xb", "0xc"], failedTxs: [] })

        const ok = await syncBlock(block, peer)

        expect(ok).toBe(true)
        expect(applyTransactions).toHaveBeenCalledTimes(1)
        expect(insertBlock).toHaveBeenCalledTimes(1)
        expect(insertTransactionsFromSync).toHaveBeenCalledTimes(1)
    })
})
