/**
 * Relaying an L2PS hash update over HTTP.
 *
 * When OmniProtocol is off or fails, the hash service falls back to the DTR
 * relay call, one validator at a time, until one accepts.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const relayTransaction = jest.fn(async (_validator: any, _payload: any[], _blockRef: string) => ({
    result: 200,
    response: "ok",
    require_reply: false,
    extra: null,
}))

const validators = [
    { identity: "0xself", status: { online: true }, sync: { status: true } },
    { identity: "0xaaaa1111", status: { online: true }, sync: { status: true } },
    { identity: "0xbbbb2222", status: { online: true }, sync: { status: true } },
]

const sharedState = {
    PROD: true,
    publicKeyHex: "0xself",
    lastBlockHash: "0xtip",
}

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => sharedState },
    getSharedState: sharedState,
}))
jest.mock("@/libs/network/dtr/dtrmanager", () => ({
    DTRManager: { relayTransaction },
}))
jest.mock("@/libs/consensus/v2/routines/getShard", () => ({
    __esModule: true,
    default: async () => validators,
}))
jest.mock("@/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "seed", lastBlockNumber: 1 }),
}))
jest.mock("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: {},
    L2PS_STATUS: {},
}))
jest.mock("@/libs/blockchain/routines/validateTransaction", () => ({
    confirmTransaction: async () => null,
}))
jest.mock("@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser", () => ({
    __esModule: true,
    default: async () => null,
}))

const { L2PSHashService } = await import("./L2PSHashService")

const validityData = { data: { transaction: { hash: "0xhashupdate" } } } as any

function relay(): Promise<void> {
    const service = L2PSHashService.getInstance() as any
    service.omniEnabled = false
    return service.relayToValidators({ hash: "0xhashupdate" }, validityData)
}

describe("L2PS hash relay over HTTP", () => {
    beforeEach(() => {
        relayTransaction.mockClear()
    })

    it("sends the update to one validator, anchored to the current tip", async () => {
        await relay()

        expect(relayTransaction).toHaveBeenCalledTimes(1)
        const [validator, payload, blockRef] = relayTransaction.mock.calls[0]
        expect(validator.identity).not.toBe("0xself")
        expect(payload).toEqual([validityData])
        expect(blockRef).toBe("0xtip")
    })

    it("moves on to the next validator when one refuses", async () => {
        relayTransaction.mockImplementationOnce(async () => ({
            result: 409,
            response: "different tip",
            require_reply: false,
            extra: null,
        }))

        await relay()

        expect(relayTransaction).toHaveBeenCalledTimes(2)
        const tried = relayTransaction.mock.calls.map(([v]) => v.identity)
        expect(new Set(tried).size).toBe(2)
    })

    it("fails when every validator refuses", async () => {
        relayTransaction.mockImplementation(async () => ({
            result: 500,
            response: "down",
            require_reply: false,
            extra: null,
        }))

        await expect(relay()).rejects.toThrow("All 2 validators failed")
    })
})
