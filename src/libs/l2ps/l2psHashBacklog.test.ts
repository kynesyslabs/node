/**
 * What a hash cycle asks the queue for.
 *
 * The cycle needs the number of executed rows, not the rows. Loading them to
 * take a length is what makes a deep backlog expensive on every pass.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const getHashForL2PS = jest.fn(async (..._args: unknown[]) => "0xconsolidated")
const getSummaryByUIDAndStatus = jest.fn(async (..._args: unknown[]) => ({
    count: 12345,
    oldestTimestamp: "1",
    newestTimestamp: "2",
}))
const getByUID = jest.fn(async (..._args: unknown[]) => [] as unknown[])
const createL2PSHashUpdate = jest.fn(async (..._args: unknown[]) => ({
    content: { from: "0xself", nonce: 7 },
}))

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => ({ l2psJoinedUids: ["subnet_a"] }) },
    getSharedState: { PROD: false, publicKeyHex: "0xself" },
}))
jest.mock("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getHashForL2PS, getSummaryByUIDAndStatus, getByUID },
    L2PS_STATUS: { EXECUTED: "executed" },
}))
jest.mock("@kynesyslabs/demosdk/websdk", () => ({
    Demos: class {},
    DemosTransactions: { createL2PSHashUpdate },
}))
jest.mock("@/libs/blockchain/routines/validateTransaction", () => ({
    confirmTransaction: async () => null,
}))
jest.mock("@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser", () => ({
    __esModule: true,
    default: async () => null,
}))
jest.mock("@/libs/network/dtr/dtrmanager", () => ({ DTRManager: {} }))
jest.mock("@/libs/consensus/v2/routines/getShard", () => ({
    __esModule: true,
    default: async () => [],
}))
jest.mock("@/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "seed", lastBlockNumber: 1 }),
}))
jest.mock("@/utilities/logger", () => ({
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
})

describe("hash cycle over the executed queue", () => {
    it("takes the backlog size from a count and loads no rows", async () => {
        const service = L2PSHashService.getInstance() as any
        service.demos = {}

        for (let cycle = 0; cycle < 20; cycle++) {
            await service.processL2PSNetwork("subnet_a")
        }

        expect(getByUID).not.toHaveBeenCalled()
        expect(createL2PSHashUpdate).toHaveBeenCalledTimes(20)
        expect(createL2PSHashUpdate.mock.calls[0][2]).toBe(12345)
    })
})
