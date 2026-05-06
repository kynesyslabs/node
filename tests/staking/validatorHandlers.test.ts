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

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorStatus: jest.fn(),
        getGCRValidatorsAtBlock: jest.fn(),
    },
}))

import GCR from "@/libs/blockchain/gcr/gcr"

let validatorHandlers: typeof import("@/libs/network/handlers/validatorHandlers").validatorHandlers

beforeAll(async () => {
    ({ validatorHandlers } = await import(
        "@/libs/network/handlers/validatorHandlers"
    ))
})

function emptyResponse() {
    return {
        result: 200,
        response: null as unknown,
        require_reply: false,
        extra: null as unknown,
    }
}

function validatorRow(overrides: Record<string, unknown> = {}) {
    return {
        address: "aabbcc",
        status: "2",
        connection_url: "https://v.example",
        staked_amount: "42",
        first_seen: 10,
        valid_at: 10,
        unstake_requested_at: null,
        unstake_available_at: null,
        ...overrides,
    }
}

describe("validatorHandlers.getValidatorInfo", () => {
    beforeEach(() => jest.clearAllMocks())

    it("returns a serialized validator for a known address", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            validatorRow() as never,
        )
        const r = await validatorHandlers.getValidatorInfo(
            { address: "aabbcc" },
            emptyResponse(),
        )
        expect(r.response).toMatchObject({
            address: "aabbcc",
            status: "2",
            stakedAmount: "42",
            connectionUrl: "https://v.example",
            unstakeRequestedAt: null,
            unstakeAvailableAt: null,
        })
    })

    it("returns null for an unknown address", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const r = await validatorHandlers.getValidatorInfo(
            { address: "nope" },
            emptyResponse(),
        )
        expect(r.response).toBeNull()
    })

    it("accepts a bare-string argument", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            validatorRow() as never,
        )
        const r = await validatorHandlers.getValidatorInfo(
            "aabbcc",
            emptyResponse(),
        )
        expect((r.response as { address?: string }).address).toBe("aabbcc")
    })

    it("rejects a missing address", async () => {
        const r = await validatorHandlers.getValidatorInfo({}, emptyResponse())
        expect(r.result).toBe(400)
        expect((r.response as { error?: string }).error).toMatch(/address/)
    })
})

describe("validatorHandlers.getValidators", () => {
    beforeEach(() => jest.clearAllMocks())

    it("serializes the full validator set", async () => {
        (GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            validatorRow(),
            validatorRow({ address: "ddeeff", staked_amount: "100" }),
        ] as never)
        const r = await validatorHandlers.getValidators({}, emptyResponse())
        expect(Array.isArray(r.response)).toBe(true)
        expect((r.response as unknown[]).length).toBe(2)
        expect((r.response as { stakedAmount: string }[])[1].stakedAmount).toBe(
            "100",
        )
    })

    it("passes an explicit blockNumber through", async () => {
        const getAt = GCR.getGCRValidatorsAtBlock as jest.Mock
        getAt.mockResolvedValue([] as never)
        await validatorHandlers.getValidators(
            { blockNumber: 42 },
            emptyResponse(),
        )
        expect(getAt).toHaveBeenCalledWith(42)
    })

    it("returns a 500 on repository error", async () => {
        (GCR.getGCRValidatorsAtBlock as jest.Mock).mockRejectedValue(
            new Error("boom") as never,
        )
        const r = await validatorHandlers.getValidators({}, emptyResponse())
        expect(r.result).toBe(500)
    })
})

describe("validatorHandlers.getStakedAmount", () => {
    beforeEach(() => jest.clearAllMocks())

    it("returns staked_amount when set", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            validatorRow({ staked_amount: "123" }) as never,
        )
        const r = await validatorHandlers.getStakedAmount(
            "aabbcc",
            emptyResponse(),
        )
        expect(r.response).toBe("123")
    })

    it("returns \"0\" when staked_amount is null (new validator row or exited)", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            validatorRow({ staked_amount: null }) as never,
        )
        const r = await validatorHandlers.getStakedAmount(
            "aabbcc",
            emptyResponse(),
        )
        expect(r.response).toBe("0")
    })

    it("returns \"0\" for a non-validator", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const r = await validatorHandlers.getStakedAmount(
            "unknown",
            emptyResponse(),
        )
        expect(r.response).toBe("0")
    })

    it("rejects a missing address", async () => {
        const r = await validatorHandlers.getStakedAmount({}, emptyResponse())
        expect(r.result).toBe(400)
    })
})
