// Regression test for #62 (M-2): per-tx flat fee equals
// networkFee + rpcFee + burnFee (default 1+1+1 = 3) and is independent
// of payload size and congestion.
//
// When dynamic surge pricing is re-enabled, this test should evolve to
// cover the multiplier path. For now it pins the flat-fee invariant.

import { beforeEach, describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        custom: jest.fn(),
    },
}))

const sharedStateStub: {
    networkFee: number
    rpcFee: number
    burnFee: number
} = { networkFee: 1, rpcFee: 1, burnFee: 1 }

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: sharedStateStub,
}))

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn() },
}))
jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRLastBlockBaseGas: jest.fn() },
}))

import calculateCurrentGas, {
    calculateFeeBreakdown,
} from "@/libs/blockchain/routines/calculateCurrentGas"

describe("calculateCurrentGas — flat fee = networkFee + rpcFee + burnFee", () => {
    beforeEach(() => {
        sharedStateStub.networkFee = 1
        sharedStateStub.rpcFee = 1
        sharedStateStub.burnFee = 1
    })

    it("returns 3 with default 1/1/1 fees regardless of payload", async () => {
        expect(await calculateCurrentGas({ a: "small" })).toBe(3)
        expect(
            await calculateCurrentGas({
                whatever: "much-larger-payload",
                with: ["nested", "stuff", { lots: "more" }],
            }),
        ).toBe(3)
    })

    it("scales linearly when each fee component is bumped", async () => {
        sharedStateStub.networkFee = 5
        sharedStateStub.rpcFee = 7
        sharedStateStub.burnFee = 11
        expect(await calculateCurrentGas({ x: 1 })).toBe(23)
    })

    it("treats zero-valued components as zero", async () => {
        sharedStateStub.networkFee = 0
        sharedStateStub.rpcFee = 0
        sharedStateStub.burnFee = 0
        expect(await calculateCurrentGas({ x: 1 })).toBe(0)
    })
})

// DEM-665: new per-component breakdown used by the post-fork
// fee-distribution edit generator (P5). Does NOT read burnFee — the
// burned share is derived from per-component distribution percentages
// in NetworkParameters (P13), not from a separate scalar.
describe("calculateFeeBreakdown — per-component split (DEM-665)", () => {
    beforeEach(() => {
        sharedStateStub.networkFee = 1
        sharedStateStub.rpcFee = 1
        sharedStateStub.burnFee = 1
    })

    it("returns {network_fee, rpc_fee, additional_fee, total} with defaults", async () => {
        const b = await calculateFeeBreakdown({ x: 1 })
        expect(b.network_fee).toBe(1)
        expect(b.rpc_fee).toBe(1)
        expect(b.additional_fee).toBe(0)
        expect(b.total).toBe(2) // burnFee NOT counted post-fork
    })

    it("scales each component independently", async () => {
        sharedStateStub.networkFee = 5
        sharedStateStub.rpcFee = 7
        // burnFee bump is INTENTIONALLY ignored by the breakdown path.
        sharedStateStub.burnFee = 999
        const b = await calculateFeeBreakdown({ x: 1 })
        expect(b.network_fee).toBe(5)
        expect(b.rpc_fee).toBe(7)
        expect(b.additional_fee).toBe(0)
        expect(b.total).toBe(12)
    })

    it("total equals sum of components", async () => {
        sharedStateStub.networkFee = 3
        sharedStateStub.rpcFee = 4
        const b = await calculateFeeBreakdown({ x: 1 })
        expect(b.total).toBe(b.network_fee + b.rpc_fee + b.additional_fee)
    })

    it("zero components yield zero total", async () => {
        sharedStateStub.networkFee = 0
        sharedStateStub.rpcFee = 0
        sharedStateStub.burnFee = 0
        const b = await calculateFeeBreakdown({ x: 1 })
        expect(b.total).toBe(0)
    })

    it("additional_fee is always 0 until a dApp fee path lands", async () => {
        const b1 = await calculateFeeBreakdown({ x: 1 })
        sharedStateStub.networkFee = 100
        const b2 = await calculateFeeBreakdown({ y: 2 })
        expect(b1.additional_fee).toBe(0)
        expect(b2.additional_fee).toBe(0)
    })
})
