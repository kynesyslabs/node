/**
 * The `mempool` method is the validators' mempool merge, which admits txs
 * without the nonce, balance and fee checks of a submit. It is therefore
 * open only to a signed request from a merge-eligible validator, over every
 * transport that reaches it, and a payload that cannot be a pool is refused
 * before any validation work.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const STAKED = "0x" + "11".repeat(32)
const OUTSIDER = "0x" + "22".repeat(32)

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
const receive = jest.fn(async (..._args: unknown[]) => ({
    success: true,
    mempool: [{ hash: "0xdiff" }],
}))
const contributePeerlist = jest.fn()

mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/sharedState", () => ({ getSharedState: { publicKeyHex: "0xself" } }))
mock.module("src/libs/consensus/mergePeerEligibility", () => ({
    isMergePeerEligible: async (key: string) => key.toLowerCase() === STAKED,
}))
mock.module("src/libs/blockchain/mempool", () => ({ __esModule: true, default: { receive } }))
mock.module("src/libs/consensus/v2/routines/peerlistMerge", () => ({
    contributePeerlist,
    getLocalSyncObservations: () => ["obs"],
}))
mock.module("src/libs/peer/PeerManager", () => ({ __esModule: true, default: {} }))
mock.module("./routines/transactions/handleL2PS", () => ({ __esModule: true, default: jest.fn() }))
mock.module("./routines/transactions/demosWork/handleDemosWorkRequest", () => ({ __esModule: true, default: jest.fn() }))
mock.module("src/features/multichain/XMDispatcher", () => ({ __esModule: true, default: {} }))
mock.module("./routines/transactions/handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest: jest.fn() }))
mock.module("../utils/web2RequestUtils", () => ({ parseWeb2ProxyRequest: jest.fn() }))
mock.module("../peer", () => ({ Peer: class {} }))
mock.module("./rpcDispatch", () => ({ emptyResponse: { result: 0, response: "", require_reply: false, extra: null } }))
mock.module("./endpointValidation", () => ({ handleValidateTransaction: jest.fn() }))
mock.module("./endpointExecution", () => ({ handleExecuteTransaction: jest.fn() }))
mock.module("./endpointConsensus", () => ({ handleConsensusRequest: jest.fn() }))
mock.module("./endpointL2PSHash", () => ({ handleL2PSHashUpdate: jest.fn() }))

const { default: ServerHandlers } = await import("./endpointHandlers")

const envelope = (txs: unknown[]) => [{ txs, peerlist: [], blockRef: 5 }]

beforeEach(() => {
    receive.mockClear()
    contributePeerlist.mockClear()
})

describe("handleMempool sender gate", () => {
    it("refuses an anonymous caller and does no validation work", async () => {
        const res = await ServerHandlers.handleMempool(envelope([{ hash: "0x1" }]), "")
        expect(res.result).toBe(401)
        expect(receive).not.toHaveBeenCalled()
        expect(contributePeerlist).not.toHaveBeenCalled()
    })

    it("refuses an authenticated key that is not merge-eligible", async () => {
        const res = await ServerHandlers.handleMempool(envelope([{ hash: "0x1" }]), OUTSIDER)
        expect(res.result).toBe(401)
        expect(res.response).toMatch(/limited to validators/)
        expect(receive).not.toHaveBeenCalled()
    })

    it("merges for an eligible validator", async () => {
        const res = await ServerHandlers.handleMempool(envelope([{ hash: "0x1" }]), STAKED)
        expect(res.result).toBe(200)
        expect(receive).toHaveBeenCalledTimes(1)
        expect(res.response).toEqual({
            txs: [{ hash: "0xdiff" }],
            peerlist: ["obs"],
        })
        expect(contributePeerlist).toHaveBeenCalledTimes(1)
    })

    it("keeps the plain-list form working for an eligible validator", async () => {
        const res = await ServerHandlers.handleMempool([{ hash: "0x1" }], STAKED)
        expect(res.result).toBe(200)
        expect(res.response).toEqual([{ hash: "0xdiff" }])
    })
})

describe("handleMempool payload shape", () => {
    it("refuses a payload that is not a list of txs", async () => {
        const res = await ServerHandlers.handleMempool("junk", STAKED)
        expect(res.result).toBe(400)
        expect(receive).not.toHaveBeenCalled()
    })

    it("refuses a batch longer than the pool can hold", async () => {
        const txs = Array.from({ length: 10_001 }, (_, i) => ({ hash: `0x${i}` }))
        const res = await ServerHandlers.handleMempool(envelope(txs), STAKED)
        expect(res.result).toBe(400)
        expect(receive).not.toHaveBeenCalled()
    })
})
