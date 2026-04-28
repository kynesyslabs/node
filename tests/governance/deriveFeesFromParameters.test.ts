// Phase 1 §1.2.6 — verifies that fee-baking reads the governance-driven
// NetworkParameters from shared state rather than hardcoded 0 literals.
//
// Targets the exported `resolveDynamicFees()` helper in
// deriveMempoolOperation.ts, which is the single read-site used by
// createOperation (and any future fee-baking call-site).

import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
} from "@jest/globals"

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
    networkParameters: unknown
    rpcFee: number
    publicKeyHex: string
} = {
    networkParameters: null,
    rpcFee: 7, // legacy flat field
    publicKeyHex: "aabbcc",
}
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: sharedStateStub,
}))

let resolveDynamicFees: typeof import("@/libs/utils/demostdlib/deriveMempoolOperation").resolveDynamicFees

beforeAll(async () => {
    ;({ resolveDynamicFees } = await import(
        "@/libs/utils/demostdlib/deriveMempoolOperation"
    ))
})

describe("resolveDynamicFees — §1.2.6 wiring", () => {
    beforeEach(() => {
        sharedStateStub.networkParameters = null
        sharedStateStub.rpcFee = 7
    })

    it("returns 0/legacy-rpcFee when networkParameters not loaded yet", () => {
        const f = resolveDynamicFees()
        expect(f.networkFee).toBe(0)
        expect(f.rpcFee).toBe(7)
    })

    it("reads networkFee + rpcFee from networkParameters when populated", () => {
        sharedStateStub.networkParameters = { networkFee: 42, rpcFee: 9 }
        const f = resolveDynamicFees()
        expect(f.networkFee).toBe(42)
        expect(f.rpcFee).toBe(9)
    })

    it("falls back to flat sharedState.rpcFee when networkParameters lacks rpcFee", () => {
        sharedStateStub.networkParameters = { networkFee: 15 }
        sharedStateStub.rpcFee = 33
        const f = resolveDynamicFees()
        expect(f.networkFee).toBe(15)
        expect(f.rpcFee).toBe(33)
    })

    it("reflects post-activation updates on subsequent reads", () => {
        sharedStateStub.networkParameters = { networkFee: 10, rpcFee: 10 }
        expect(resolveDynamicFees().networkFee).toBe(10)

        // Simulate applyNetworkUpgrade mutating shared state.
        sharedStateStub.networkParameters = { networkFee: 15, rpcFee: 10 }
        expect(resolveDynamicFees().networkFee).toBe(15)
    })

    it("guards against non-number networkFee (e.g. malformed loader state)", () => {
        sharedStateStub.networkParameters = {
            networkFee: "12" as unknown as number,
        }
        const f = resolveDynamicFees()
        expect(f.networkFee).toBe(0)
    })
})
