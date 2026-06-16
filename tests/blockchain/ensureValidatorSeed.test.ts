import {
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

const upsertExecute = jest.fn(async () => undefined)
const insertChain = {
    into: jest.fn(() => insertChain),
    values: jest.fn(() => insertChain),
    orIgnore: jest.fn(() => insertChain),
    execute: upsertExecute,
}
const queryBuilder = {
    insert: jest.fn(() => insertChain),
}
const transaction = jest.fn(async (cb: (em: unknown) => Promise<void>) => {
    await cb({ createQueryBuilder: () => queryBuilder })
})
const repoCount = jest.fn<() => Promise<number>>(async () => 0)

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: jest.fn(async () => ({
            getDataSource: () => ({
                transaction,
                getRepository: () => ({ count: repoCount }),
            }),
        })),
    },
}))

import {
    ConsensusInvariantError,
    ensureValidatorSeed,
    type GenesisValidatorSeed,
} from "@/libs/blockchain/routines/ensureValidatorSeed"

function makeSeed(overrides: Partial<GenesisValidatorSeed> = {}): GenesisValidatorSeed {
    return {
        address: "0x" + "a".repeat(64),
        status: "ACTIVE",
        connection_url: null,
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
        ...overrides,
    }
}

describe("ensureValidatorSeed", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        repoCount.mockReset()
    })

    it("no-ops when validators table has rows", async () => {
        repoCount.mockResolvedValue(5)

        const result = await ensureValidatorSeed({
            validators: [makeSeed()],
        })

        expect(result).toEqual({ reseeded: false, count: 5 })
        expect(transaction).not.toHaveBeenCalled()
        expect(upsertExecute).not.toHaveBeenCalled()
    })

    it("throws ConsensusInvariantError when table empty and genesis has no validators", async () => {
        repoCount.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({ validators: [] }),
        ).rejects.toBeInstanceOf(ConsensusInvariantError)
        expect(transaction).not.toHaveBeenCalled()
    })

    it("throws when genesisData is malformed (no validators key)", async () => {
        repoCount.mockResolvedValue(0)

        await expect(ensureValidatorSeed({})).rejects.toBeInstanceOf(
            ConsensusInvariantError,
        )
        await expect(ensureValidatorSeed(null)).rejects.toBeInstanceOf(
            ConsensusInvariantError,
        )
        await expect(
            ensureValidatorSeed({ validators: "nope" }),
        ).rejects.toBeInstanceOf(ConsensusInvariantError)
    })

    it("re-seeds and reports count when table empty and seed valid", async () => {
        // First call: pre-seed count = 0. Second call: post-seed count = 4.
        repoCount.mockResolvedValueOnce(0).mockResolvedValueOnce(4)

        const seeds = [
            makeSeed({ address: "0x" + "1".repeat(64) }),
            makeSeed({ address: "0x" + "2".repeat(64) }),
            makeSeed({ address: "0x" + "3".repeat(64) }),
            makeSeed({ address: "0x" + "4".repeat(64) }),
        ]

        const result = await ensureValidatorSeed({ validators: seeds })

        expect(result).toEqual({ reseeded: true, count: 4 })
        expect(transaction).toHaveBeenCalledTimes(1)
        expect(insertChain.orIgnore).toHaveBeenCalled()
        expect(upsertExecute).toHaveBeenCalledTimes(1)
    })

    it("throws when re-seed silently produces zero rows", async () => {
        repoCount.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({ validators: [makeSeed()] }),
        ).rejects.toBeInstanceOf(ConsensusInvariantError)
        expect(transaction).toHaveBeenCalled()
    })

    it("rejects malformed address", async () => {
        repoCount.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ address: "not-hex" })],
            }),
        ).rejects.toThrow(/address invalid/)
        expect(transaction).not.toHaveBeenCalled()
    })

    it("rejects empty status", async () => {
        repoCount.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ status: "" })],
            }),
        ).rejects.toThrow(/status/)
        expect(transaction).not.toHaveBeenCalled()
    })

    it("rejects non-string status", async () => {
        repoCount.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                // status is typed as `string` on GenesisValidatorSeed; runtime
                // genesis.json is hand-edited, so the validator must catch a
                // numeric value too — mirrors seedValidators.validateSeed.
                validators: [makeSeed({ status: 2 as unknown as string })],
            }),
        ).rejects.toThrow(/status/)
    })

    it("rejects zero stake", async () => {
        repoCount.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ staked_amount: "0" })],
            }),
        ).rejects.toThrow(/staked_amount must be > 0/)
    })

    it("rejects non-bigint stake string", async () => {
        repoCount.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ staked_amount: "1.5" })],
            }),
        ).rejects.toThrow(/staked_amount is not a valid bigint/)
    })

    it("rejects negative valid_at", async () => {
        repoCount.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ valid_at: -1 })],
            }),
        ).rejects.toThrow(/valid_at/)
    })

    it("rejects empty connection_url string", async () => {
        repoCount.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ connection_url: "" })],
            }),
        ).rejects.toThrow(/connection_url/)
    })

    it("accepts non-null connection_url string", async () => {
        repoCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1)

        const result = await ensureValidatorSeed({
            validators: [makeSeed({ connection_url: "https://node.example" })],
        })

        expect(result).toEqual({ reseeded: true, count: 1 })
    })
})
