/**
 * What a hash cycle asks the queue for.
 *
 * The cycle needs the number of executed rows, not the rows. Loading them to
 * take a length is what makes a deep backlog expensive on every pass.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const getDigestWithCount = jest.fn(async (..._args: unknown[]) => ({ hash: "0xconsolidated", count: 12345 }))
const getSummaryByUIDAndStatus = jest.fn()
const getByUID = jest.fn(async (..._args: unknown[]) => [] as unknown[])
const createL2PSHashUpdate = jest.fn(async (..._args: unknown[]) => ({
    content: { from: "0xself", nonce: 7 },
}))

mock.module("@/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => ({ l2psJoinedUids: ["subnet_a"] }) },
    getSharedState: { PROD: false, publicKeyHex: "0xself" },
}))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getDigestWithCount, getSummaryByUIDAndStatus, getByUID },
    L2PS_STATUS: { EXECUTED: "executed" },
}))
mock.module("@kynesyslabs/demosdk/websdk", () => ({
    Demos: class {},
    DemosTransactions: { createL2PSHashUpdate },
}))
mock.module("@/libs/blockchain/routines/validateTransaction", () => ({
    confirmTransaction: async () => null,
}))
mock.module("@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser", () => ({
    __esModule: true,
    default: async () => null,
}))
mock.module("@/libs/network/dtr/dtrmanager", () => ({ DTRManager: {} }))
mock.module("@/libs/consensus/v2/routines/getShard", () => ({
    __esModule: true,
    default: async () => [],
}))
mock.module("@/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "seed", lastBlockNumber: 1 }),
}))
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

const { L2PSHashService } = await import("./L2PSHashService")

beforeEach(() => {
    getByUID.mockClear()
    getSummaryByUIDAndStatus.mockClear()
    createL2PSHashUpdate.mockClear()
    getDigestWithCount.mockClear()
})

describe("hash cycle over the executed queue", () => {
    it("takes the backlog size from a count and loads no rows", async () => {
        const service = L2PSHashService.getInstance() as any
        service.demos = {}

        for (let cycle = 0; cycle < 20; cycle++) {
            await service.processL2PSNetwork("subnet_a")
        }

        expect(getByUID).not.toHaveBeenCalled()
        expect(getSummaryByUIDAndStatus).not.toHaveBeenCalled()
        expect(createL2PSHashUpdate).toHaveBeenCalledTimes(20)
        // The count and the hash come from the same call, so they describe one snapshot.
        expect(createL2PSHashUpdate.mock.calls[0].slice(1, 3)).toEqual(["0xconsolidated", 12345])
    })

    it("publishes nothing for a subnet whose digest could not be read", async () => {
        getDigestWithCount.mockRejectedValueOnce(new Error("connection lost"))
        const service = L2PSHashService.getInstance() as any
        service.demos = {}

        await service.processL2PSNetwork("subnet_a")

        expect(createL2PSHashUpdate).not.toHaveBeenCalled()
    })

    it("publishes nothing for an empty queue", async () => {
        getDigestWithCount.mockResolvedValueOnce({ hash: "0xempty", count: 0 })
        const service = L2PSHashService.getInstance() as any
        service.demos = {}

        await service.processL2PSNetwork("subnet_a")

        expect(createL2PSHashUpdate).not.toHaveBeenCalled()
    })
})
