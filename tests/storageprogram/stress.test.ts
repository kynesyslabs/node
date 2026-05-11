import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

// Mock logger
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}))

// Mock SDK
jest.mock("@kynesyslabs/demosdk", () => ({
    __esModule: true,
    types: {},
    storage: {},
}))

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

let GCRStorageProgramRoutines: typeof import("src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines")["GCRStorageProgramRoutines"]
let validateStorageProgramPayload: typeof import("src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines")["validateStorageProgramPayload"]

beforeAll(async () => {
    ({ GCRStorageProgramRoutines, validateStorageProgramPayload } =
        await import(
            "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
        ))
})

function createMockRepository() {
    return {
        findOneBy: jest.fn(),
        find: jest.fn(),
        save: jest.fn(),
        createQueryBuilder: jest.fn(() => ({
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockReturnThis(),
            skip: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([]),
        })),
    }
}

describe("StorageProgram stress tests", () => {
    let repo: ReturnType<typeof createMockRepository>

    beforeEach(() => {
        jest.clearAllMocks()
        repo = createMockRepository()
    })

    // =========================================================================
    // Concurrent operations
    // =========================================================================
    describe("concurrent operations", () => {
        it("handles 50 concurrent creates without errors", async () => {
            repo.findOneBy.mockResolvedValue(null)
            repo.save.mockImplementation(async (p: any) => p)

            const promises = Array.from({ length: 50 }, (_, i) => {
                const edit = {
                    target: `stor-concurrent-${i}`,
                    type: "storageProgram",
                    context: {
                        operation: "CREATE_STORAGE_PROGRAM",
                        sender: `owner_${i}`,
                        data: {
                            variables: {
                                operation: "CREATE_STORAGE_PROGRAM",
                                storageAddress: `stor-concurrent-${i}`,
                                programName: `prog-${i}`,
                                encoding: "json",
                                data: { index: i },
                                acl: { mode: "public" },
                            },
                        },
                    },
                    txhash: `tx_concurrent_${i}`,
                }
                return GCRStorageProgramRoutines.apply(
                    edit as any,
                    repo as any,
                    false,
                )
            })

            const results = await Promise.all(promises)
            const successes = results.filter((r) => r.success)
            expect(successes.length).toBe(50)
        })

        it("handles 20 concurrent writes to same program", async () => {
            const baseProgram = {
                storageAddress: "stor-shared",
                owner: "owner1",
                programName: "shared",
                encoding: "json",
                data: { counter: 0 },
                sizeBytes: 20,
                acl: { mode: "public" },
                metadata: null,
                storageLocation: "onchain",
                ipfsCid: null,
                salt: null,
                createdByTx: "tx0",
                lastModifiedByTx: "tx0",
                interactionTxs: ["tx0"],
                totalFeesPaid: 1n,
                isDeleted: false,
                deletedByTx: null,
            }

            repo.findOneBy.mockResolvedValue(baseProgram)
            repo.save.mockImplementation(async (p: any) => p)

            const promises = Array.from({ length: 20 }, (_, i) => {
                const edit = {
                    target: "stor-shared",
                    type: "storageProgram",
                    context: {
                        operation: "WRITE_STORAGE",
                        sender: "owner1",
                        data: {
                            variables: {
                                operation: "WRITE_STORAGE",
                                storageAddress: "stor-shared",
                                data: { counter: i },
                                encoding: "json",
                            },
                        },
                    },
                    txhash: `tx_write_${i}`,
                }
                return GCRStorageProgramRoutines.apply(
                    edit as any,
                    repo as any,
                    false,
                )
            })

            const results = await Promise.all(promises)
            const successes = results.filter((r) => r.success)
            expect(successes.length).toBe(20)
            expect(repo.save).toHaveBeenCalledTimes(20)
        })
    })

    // =========================================================================
    // Large payload boundaries
    // =========================================================================
    describe("payload boundaries", () => {
        it("accepts 999KB payload", () => {
            const data = { payload: "x".repeat(999 * 1024) }
            const result = validateStorageProgramPayload(
                {
                    operation: "CREATE_STORAGE_PROGRAM",
                    storageAddress: "stor-large",
                    programName: "large",
                    encoding: "json",
                    data,
                } as any,
                "sender",
            )
            expect(result.valid).toBe(true)
        })

        it("rejects payload just over 1MB", () => {
            const data = { payload: "x".repeat(1048577) }
            const result = validateStorageProgramPayload(
                {
                    operation: "CREATE_STORAGE_PROGRAM",
                    storageAddress: "stor-huge",
                    programName: "huge",
                    encoding: "json",
                    data,
                } as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("exceeds maximum")
        })

        it("depth boundary: 64 passes, 65 fails", () => {
            function createNested(depth: number): Record<string, unknown> {
                let obj: Record<string, unknown> = { leaf: true }
                for (let i = 0; i < depth - 1; i++) {
                    obj = { nested: obj }
                }
                return obj
            }

            const ok = validateStorageProgramPayload(
                {
                    operation: "CREATE_STORAGE_PROGRAM",
                    storageAddress: "stor-deep-ok",
                    programName: "deep",
                    encoding: "json",
                    data: createNested(64),
                } as any,
                "sender",
            )
            expect(ok.valid).toBe(true)

            const fail = validateStorageProgramPayload(
                {
                    operation: "CREATE_STORAGE_PROGRAM",
                    storageAddress: "stor-deep-fail",
                    programName: "deep",
                    encoding: "json",
                    data: createNested(65),
                } as any,
                "sender",
            )
            expect(fail.valid).toBe(false)
        })
    })

    // =========================================================================
    // InteractionTxs cap (Bug #3)
    // =========================================================================
    describe("interactionTxs cap", () => {
        it("caps at 1000 entries after many writes", async () => {
            const largeTxList = Array.from(
                { length: 1500 },
                (_, i) => `tx_old_${i}`,
            )
            const prog = {
                storageAddress: "stor-txcap",
                owner: "owner1",
                programName: "txcap",
                encoding: "json",
                data: { val: 1 },
                sizeBytes: 10,
                acl: { mode: "public" },
                metadata: null,
                storageLocation: "onchain",
                ipfsCid: null,
                salt: null,
                createdByTx: "tx0",
                lastModifiedByTx: "tx0",
                interactionTxs: largeTxList,
                totalFeesPaid: 1n,
                isDeleted: false,
                deletedByTx: null,
            }

            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockImplementation(async (p: any) => p)

            const edit = {
                target: "stor-txcap",
                type: "storageProgram",
                context: {
                    operation: "WRITE_STORAGE",
                    sender: "owner1",
                    data: {
                        variables: {
                            operation: "WRITE_STORAGE",
                            storageAddress: "stor-txcap",
                            data: { val: 2 },
                            encoding: "json",
                        },
                    },
                },
                txhash: "tx_new_write",
            }

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)

            const saved = repo.save.mock.calls[0][0] as any
            expect(saved.interactionTxs.length).toBeLessThanOrEqual(1000)
            // Last entry should be the new txhash
            expect(
                saved.interactionTxs[saved.interactionTxs.length - 1],
            ).toBe("tx_new_write")
        })
    })
})
