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

const chainLastBlock = jest.fn<() => Promise<number>>(async () => 0)
jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: chainLastBlock },
}))

type SnapshotMockShape =
    | { available: false }
    | {
          available: true
          manifest: { files: Record<string, unknown> }
          streamValidators: () => AsyncIterable<unknown>
      }

const snapshotLoader = jest.fn<() => Promise<SnapshotMockShape>>(async () => ({
    available: false,
}))
jest.mock("@/libs/blockchain/genesis/loadSnapshot", () => ({
    __esModule: true,
    loadSnapshot: snapshotLoader,
}))

function makeSnapshotValidator(addr: string) {
    return {
        address: addr,
        status: "2",
        connection_url: null as string | null,
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
        unstake_requested_at: null,
        unstake_available_at: null,
    }
}

function snapshotWith(addrs: string[]): SnapshotMockShape {
    return {
        available: true,
        manifest: { files: { "validators.jsonl": {} } },
        streamValidators: async function* () {
            for (const a of addrs) yield makeSnapshotValidator(a)
        },
    }
}

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
        chainLastBlock.mockReset()
        chainLastBlock.mockResolvedValue(0)
        snapshotLoader.mockReset()
        snapshotLoader.mockResolvedValue({ available: false })
    })

    it("no-ops when validators table has rows", async () => {
        repoCount.mockResolvedValue(5)

        const result = await ensureValidatorSeed({
            validators: [makeSeed()],
        })

        expect(result).toEqual({ reseeded: false, count: 5, source: null })
        expect(transaction).not.toHaveBeenCalled()
        expect(upsertExecute).not.toHaveBeenCalled()
        // No reason to consult the chain head or the snapshot when the table is healthy.
        expect(chainLastBlock).not.toHaveBeenCalled()
        expect(snapshotLoader).not.toHaveBeenCalled()
    })

    it("prefers snapshot validators when available, even at advanced block", async () => {
        repoCount.mockResolvedValueOnce(0).mockResolvedValueOnce(7)
        chainLastBlock.mockResolvedValue(12_345)
        snapshotLoader.mockResolvedValue(
            snapshotWith([
                "0x" + "1".repeat(64),
                "0x" + "2".repeat(64),
                "0x" + "3".repeat(64),
                "0x" + "4".repeat(64),
                "0x" + "5".repeat(64),
                "0x" + "6".repeat(64),
                "0x" + "7".repeat(64),
            ]),
        )

        const result = await ensureValidatorSeed({ validators: [] })

        expect(result).toEqual({ reseeded: true, count: 7, source: "snapshot" })
        expect(transaction).toHaveBeenCalledTimes(1)
        expect(upsertExecute).toHaveBeenCalledTimes(1)
    })

    it("refuses to boot at block > 0 when no snapshot validators available", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(9_001)
        snapshotLoader.mockResolvedValue({ available: false })

        await expect(
            ensureValidatorSeed({ validators: [makeSeed()] }),
        ).rejects.toThrow(/at block 9001.*no usable snapshot/s)
        expect(transaction).not.toHaveBeenCalled()
    })

    it("refuses to boot at block > 0 when snapshot has no validators.jsonl", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(42)
        snapshotLoader.mockResolvedValue({
            available: true,
            manifest: { files: {} },
            streamValidators: async function* () {
                /* nothing */
            },
        })

        await expect(
            ensureValidatorSeed({ validators: [makeSeed()] }),
        ).rejects.toBeInstanceOf(ConsensusInvariantError)
    })

    it("falls back to genesis at block 0 when snapshot is absent", async () => {
        repoCount.mockResolvedValueOnce(0).mockResolvedValueOnce(4)
        chainLastBlock.mockResolvedValue(0)

        const seeds = [
            makeSeed({ address: "0x" + "1".repeat(64) }),
            makeSeed({ address: "0x" + "2".repeat(64) }),
            makeSeed({ address: "0x" + "3".repeat(64) }),
            makeSeed({ address: "0x" + "4".repeat(64) }),
        ]

        const result = await ensureValidatorSeed({ validators: seeds })

        expect(result).toEqual({ reseeded: true, count: 4, source: "genesis" })
        expect(transaction).toHaveBeenCalledTimes(1)
    })

    it("throws at block 0 when neither snapshot nor genesis has validators", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({ validators: [] }),
        ).rejects.toThrow(/neither data\/snapshot.* nor data\/genesis/)
    })

    it("throws when genesisData malformed at block 0 + no snapshot", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

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

    it("throws when re-seed silently produces zero rows", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({ validators: [makeSeed()] }),
        ).rejects.toThrow(/produced 0 rows/)
        expect(transaction).toHaveBeenCalled()
    })

    it("treats snapshot load failure as 'no snapshot' and falls through", async () => {
        repoCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1)
        chainLastBlock.mockResolvedValue(0)
        snapshotLoader.mockRejectedValue(new Error("disk read flake"))

        const result = await ensureValidatorSeed({
            validators: [makeSeed()],
        })

        expect(result).toEqual({ reseeded: true, count: 1, source: "genesis" })
    })

    it("treats snapshot stream failure as 'no snapshot' and falls through at block 0", async () => {
        repoCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1)
        chainLastBlock.mockResolvedValue(0)
        snapshotLoader.mockResolvedValue({
            available: true,
            manifest: { files: { "validators.jsonl": {} } },
            streamValidators: async function* () {
                throw new Error("corrupt jsonl")
            },
        })

        const result = await ensureValidatorSeed({
            validators: [makeSeed()],
        })

        expect(result).toEqual({ reseeded: true, count: 1, source: "genesis" })
    })

    it("rejects malformed address (genesis path only — snapshot validation is upstream)", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ address: "not-hex" })],
            }),
        ).rejects.toThrow(/address invalid/)
        expect(transaction).not.toHaveBeenCalled()
    })

    it("rejects null entry in validators[]", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [null as unknown as GenesisValidatorSeed],
            }),
        ).rejects.toThrow(/must be an object/)
    })

    it("rejects primitive entry in validators[]", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: ["nope" as unknown as GenesisValidatorSeed],
            }),
        ).rejects.toThrow(/must be an object/)
    })

    it("rejects empty status", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ status: "" })],
            }),
        ).rejects.toThrow(/status/)
    })

    it("rejects non-string status", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ status: 2 as unknown as string })],
            }),
        ).rejects.toThrow(/status/)
    })

    it("rejects zero stake", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ staked_amount: "0" })],
            }),
        ).rejects.toThrow(/staked_amount must be > 0/)
    })

    it("rejects non-bigint stake string", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ staked_amount: "1.5" })],
            }),
        ).rejects.toThrow(/staked_amount is not a valid bigint/)
    })

    it("rejects negative valid_at", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ valid_at: -1 })],
            }),
        ).rejects.toThrow(/valid_at/)
    })

    it("rejects empty connection_url string", async () => {
        repoCount.mockResolvedValue(0)
        chainLastBlock.mockResolvedValue(0)

        await expect(
            ensureValidatorSeed({
                validators: [makeSeed({ connection_url: "" })],
            }),
        ).rejects.toThrow(/connection_url/)
    })

    it("accepts non-null connection_url string", async () => {
        repoCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1)
        chainLastBlock.mockResolvedValue(0)

        const result = await ensureValidatorSeed({
            validators: [makeSeed({ connection_url: "https://node.example" })],
        })

        expect(result).toEqual({ reseeded: true, count: 1, source: "genesis" })
    })
})
