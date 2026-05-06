import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { readFileSync } from "fs"
import path from "path"

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

const fixturesDir = path.join(__dirname, "../../fixtures/storageprogram")
const entityFixtures = JSON.parse(
    readFileSync(
        path.join(fixturesDir, "storage_program_entity.json"),
        "utf8",
    ),
)

let GCRStorageProgramRoutines: typeof import("src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines")["GCRStorageProgramRoutines"]

beforeAll(async () => {
    const mod = await import(
        "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
    )
    GCRStorageProgramRoutines = mod.GCRStorageProgramRoutines
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

/**
 * Build a chainable QueryBuilder mock. The chain methods return `this`, and
 * `getMany` resolves with the rows the test wants the DB to "return".
 *
 * `withPagination: true` adds the `take`/`skip` chain methods used by the
 * search routine (the by-owner routine's QueryBuilder path doesn't paginate).
 */
type MockQB = {
    where: jest.Mock
    andWhere: jest.Mock
    orderBy: jest.Mock
    getMany: jest.Mock
    take?: jest.Mock
    skip?: jest.Mock
}
function makeMockQueryBuilder(options?: {
    rows?: unknown[]
    /**
     * Retained for backward compatibility — `take`/`skip` are now always
     * mocked because both `searchStorageProgramsByName` and
     * `getStorageProgramsByOwner` apply SQL pagination.
     */
    withPagination?: boolean
}): MockQB {
    const qb: MockQB = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getMany: jest
            .fn<() => Promise<unknown[]>>()
            .mockResolvedValue(options?.rows ?? []),
    }
    return qb
}

/**
 * Find the andWhere() call whose SQL fragment matches a substring. Returns
 * the [sql, params] tuple or undefined. Used to assert that a specific ACL
 * branch was added to the QueryBuilder.
 */
function findAndWhereCall(
    qb: MockQB,
    sqlFragment: string,
): [string, Record<string, unknown> | undefined] | undefined {
    return qb.andWhere.mock.calls.find(
        (c: unknown[]) =>
            typeof c[0] === "string" && (c[0] as string).includes(sqlFragment),
    ) as [string, Record<string, unknown> | undefined] | undefined
}

function makeEdit(
    operation: string,
    sender: string,
    target: string,
    extra: Record<string, unknown> = {},
) {
    return {
        target,
        type: "storageProgram",
        context: {
            operation,
            sender,
            data: {
                variables: {
                    operation,
                    storageAddress: target,
                    ...extra,
                },
            },
        },
        txhash: `tx_${operation.toLowerCase()}_${Date.now()}`,
    }
}

describe("GCRStorageProgramRoutines", () => {
    let repo: ReturnType<typeof createMockRepository>

    beforeEach(() => {
        jest.clearAllMocks()
        repo = createMockRepository()
    })

    // =========================================================================
    // CREATE_STORAGE_PROGRAM
    // =========================================================================
    describe("CREATE_STORAGE_PROGRAM", () => {
        it("creates JSON storage program successfully", async () => {
            repo.findOneBy.mockResolvedValue(null)
            repo.save.mockResolvedValue({})

            const edit = makeEdit(
                "CREATE_STORAGE_PROGRAM",
                "owner1",
                "stor-new1",
                {
                    programName: "test",
                    encoding: "json",
                    data: { key: "value" },
                    acl: { mode: "public" },
                },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)
            expect(repo.save).toHaveBeenCalled()
        })

        it("creates binary storage program successfully", async () => {
            repo.findOneBy.mockResolvedValue(null)
            repo.save.mockResolvedValue({})

            const edit = makeEdit(
                "CREATE_STORAGE_PROGRAM",
                "owner1",
                "stor-bin1",
                {
                    programName: "binary-test",
                    encoding: "binary",
                    data: "SGVsbG8=",
                    acl: { mode: "owner" },
                },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)
        })

        it("rejects duplicate non-deleted address", async () => {
            repo.findOneBy.mockResolvedValue({
                ...entityFixtures.public_json_program,
                isDeleted: false,
            })

            const edit = makeEdit(
                "CREATE_STORAGE_PROGRAM",
                "owner1",
                "stor-abc123def456",
                { programName: "dup" },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("already exists")
        })

        it("allows re-creation of deleted address", async () => {
            repo.findOneBy.mockResolvedValue({
                ...entityFixtures.deleted_program,
            })
            repo.save.mockResolvedValue({})

            const edit = makeEdit(
                "CREATE_STORAGE_PROGRAM",
                "owner1",
                "stor-deleted-999",
                {
                    programName: "reborn",
                    encoding: "json",
                    data: { new: true },
                },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)
        })

        it("rejects missing variables", async () => {
            const edit = {
                target: "stor-test",
                type: "storageProgram",
                context: {
                    operation: "CREATE_STORAGE_PROGRAM",
                    sender: "owner",
                    data: { variables: undefined },
                },
                txhash: "tx_test",
            }

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("Missing")
        })

        it("simulate mode still validates data (Bug #2 fix)", async () => {
            repo.findOneBy.mockResolvedValue(null)

            const hugeData = { big: "x".repeat(1048577) }
            const edit = makeEdit(
                "CREATE_STORAGE_PROGRAM",
                "owner1",
                "stor-huge",
                {
                    programName: "too-big",
                    encoding: "json",
                    data: hugeData,
                },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                true, // simulate
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("exceeds maximum")
            expect(repo.save).not.toHaveBeenCalled()
        })

        it("simulate mode does not save", async () => {
            repo.findOneBy.mockResolvedValue(null)

            const edit = makeEdit(
                "CREATE_STORAGE_PROGRAM",
                "owner1",
                "stor-sim",
                {
                    programName: "sim",
                    encoding: "json",
                    data: { ok: true },
                },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                true,
            )
            expect(result.success).toBe(true)
            expect(repo.save).not.toHaveBeenCalled()
        })

        it("creates with null data", async () => {
            repo.findOneBy.mockResolvedValue(null)
            repo.save.mockResolvedValue({})

            const edit = makeEdit(
                "CREATE_STORAGE_PROGRAM",
                "owner1",
                "stor-empty",
                {
                    programName: "empty",
                    data: null,
                },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)
        })
    })

    // =========================================================================
    // WRITE_STORAGE
    // =========================================================================
    describe("WRITE_STORAGE", () => {
        it("owner writes successfully", async () => {
            const prog = { ...entityFixtures.public_json_program }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockResolvedValue(prog)

            const edit = makeEdit(
                "WRITE_STORAGE",
                "owner_addr_1",
                "stor-abc123def456",
                {
                    data: { updated: true },
                    encoding: "json",
                },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)
        })

        it("non-owner without permission fails", async () => {
            const prog = { ...entityFixtures.owner_json_program }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "WRITE_STORAGE",
                "intruder",
                "stor-owner-only-789",
                { data: { hack: true } },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("No permission")
        })

        it("write to non-existent program fails", async () => {
            repo.findOneBy.mockResolvedValue(null)

            const edit = makeEdit(
                "WRITE_STORAGE",
                "owner",
                "stor-nope",
                { data: {} },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("not found")
        })

        it("write to deleted program fails", async () => {
            repo.findOneBy.mockResolvedValue({
                ...entityFixtures.deleted_program,
            })

            const edit = makeEdit(
                "WRITE_STORAGE",
                "owner_addr_1",
                "stor-deleted-999",
                { data: { nope: true } },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("deleted")
        })

        it("simulate validates oversized data (Bug #2)", async () => {
            const prog = { ...entityFixtures.public_json_program }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "WRITE_STORAGE",
                "owner_addr_1",
                "stor-abc123def456",
                {
                    data: { huge: "x".repeat(1048577) },
                    encoding: "json",
                },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                true,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("exceeds maximum")
        })

        it("interactionTxs is capped (Bug #3)", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                interactionTxs: Array.from(
                    { length: 1000 },
                    (_, i) => `tx_${i}`,
                ),
            }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockImplementation(async (p: any) => p)

            const edit = makeEdit(
                "WRITE_STORAGE",
                "owner_addr_1",
                "stor-abc123def456",
                { data: { updated: true }, encoding: "json" },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)

            const savedProgram = repo.save.mock.calls[0][0] as any
            expect(savedProgram.interactionTxs.length).toBeLessThanOrEqual(
                1000,
            )
        })

        it("metadata uses deep merge (Bug #7)", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                metadata: {
                    settings: { theme: "dark", lang: "en" },
                    version: 1,
                },
            }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockImplementation(async (p: any) => p)

            const edit = {
                target: "stor-abc123def456",
                type: "storageProgram",
                context: {
                    operation: "WRITE_STORAGE",
                    sender: "owner_addr_1",
                    data: {
                        variables: {
                            operation: "WRITE_STORAGE",
                            storageAddress: "stor-abc123def456",
                            data: { updated: true },
                            encoding: "json",
                            metadata: {
                                settings: { theme: "light" },
                            },
                        },
                        metadata: {
                            settings: { theme: "light" },
                        },
                    },
                },
                txhash: "tx_meta_test",
            }

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)

            const savedProgram = repo.save.mock.calls[0][0] as any
            // Deep merge should preserve lang
            expect(savedProgram.metadata.settings.theme).toBe("light")
            expect(savedProgram.metadata.settings.lang).toBe("en")
            expect(savedProgram.metadata.version).toBe(1)
        })
    })

    // =========================================================================
    // UPDATE_ACCESS_CONTROL
    // =========================================================================
    describe("UPDATE_ACCESS_CONTROL", () => {
        it("owner can update ACL", async () => {
            const prog = { ...entityFixtures.public_json_program }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockResolvedValue(prog)

            const edit = makeEdit(
                "UPDATE_ACCESS_CONTROL",
                "owner_addr_1",
                "stor-abc123def456",
                {
                    acl: { mode: "restricted", allowed: ["addr1"] },
                },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)
        })

        it("non-owner cannot update ACL", async () => {
            const prog = { ...entityFixtures.public_json_program }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "UPDATE_ACCESS_CONTROL",
                "intruder",
                "stor-abc123def456",
                {
                    acl: { mode: "public" },
                },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("Only owner")
        })

        it("fails on non-existent program", async () => {
            repo.findOneBy.mockResolvedValue(null)

            const edit = makeEdit(
                "UPDATE_ACCESS_CONTROL",
                "owner",
                "stor-nope",
                { acl: { mode: "owner" } },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("fails on deleted program", async () => {
            repo.findOneBy.mockResolvedValue({
                ...entityFixtures.deleted_program,
            })

            const edit = makeEdit(
                "UPDATE_ACCESS_CONTROL",
                "owner_addr_1",
                "stor-deleted-999",
                { acl: { mode: "owner" } },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
        })
    })

    // =========================================================================
    // DELETE_STORAGE_PROGRAM
    // =========================================================================
    describe("DELETE_STORAGE_PROGRAM", () => {
        it("owner soft-deletes successfully", async () => {
            const prog = { ...entityFixtures.public_json_program }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockImplementation(async (p: any) => p)

            const edit = makeEdit(
                "DELETE_STORAGE_PROGRAM",
                "owner_addr_1",
                "stor-abc123def456",
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)

            const saved = repo.save.mock.calls[0][0] as any
            expect(saved.isDeleted).toBe(true)
            expect(saved.deletedByTx).toBe(edit.txhash)
        })

        it("non-permitted address fails", async () => {
            const prog = { ...entityFixtures.owner_json_program }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "DELETE_STORAGE_PROGRAM",
                "random_addr",
                "stor-owner-only-789",
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("non-existent program fails", async () => {
            repo.findOneBy.mockResolvedValue(null)

            const edit = makeEdit(
                "DELETE_STORAGE_PROGRAM",
                "owner",
                "stor-nope",
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("not found")
        })
    })

    // =========================================================================
    // SET_FIELD
    // =========================================================================
    describe("SET_FIELD", () => {
        it("sets new field on existing data", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: { existing: "data" },
            }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockImplementation(async (p: any) => p)

            const edit = makeEdit(
                "SET_FIELD",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "newField", value: "newValue" },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)

            const saved = repo.save.mock.calls[0][0] as any
            expect(saved.data.newField).toBe("newValue")
            expect(saved.data.existing).toBe("data")
        })

        it("sets field on program with null data", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: null,
            }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockImplementation(async (p: any) => p)

            const edit = makeEdit(
                "SET_FIELD",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "key", value: "val" },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)

            const saved = repo.save.mock.calls[0][0] as any
            expect(saved.data.key).toBe("val")
        })

        it("rejects SET_FIELD on binary program", async () => {
            const prog = { ...entityFixtures.binary_program }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "SET_FIELD",
                "owner_addr_1",
                "stor-binary-789",
                { field: "key", value: "val" },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("binary")
        })

        it("rejects write without permission", async () => {
            const prog = { ...entityFixtures.owner_json_program }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "SET_FIELD",
                "intruder",
                "stor-owner-only-789",
                { field: "key", value: "val" },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("requires field name", async () => {
            const edit = makeEdit(
                "SET_FIELD",
                "owner_addr_1",
                "stor-abc123def456",
                { value: "val" },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("Field name is required")
        })
    })

    // =========================================================================
    // SET_ITEM
    // =========================================================================
    describe("SET_ITEM", () => {
        it("sets item at valid index", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: { arr: [1, 2, 3] },
            }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockImplementation(async (p: any) => p)

            const edit = makeEdit(
                "SET_ITEM",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "arr", index: 1, value: 99 },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)

            const saved = repo.save.mock.calls[0][0] as any
            expect(saved.data.arr[1]).toBe(99)
        })

        it("rejects out of bounds index", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: { arr: [1, 2] },
            }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "SET_ITEM",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "arr", index: 10, value: 99 },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("out of bounds")
        })

        it("rejects field that is not an array", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: { notArr: "string" },
            }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "SET_ITEM",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "notArr", index: 0, value: 99 },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("not an array")
        })

        it("rejects binary encoding", async () => {
            const prog = { ...entityFixtures.binary_program }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "SET_ITEM",
                "owner_addr_1",
                "stor-binary-789",
                { field: "arr", index: 0, value: 1 },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
        })
    })

    // =========================================================================
    // APPEND_ITEM
    // =========================================================================
    describe("APPEND_ITEM", () => {
        it("appends to existing array", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: { arr: [1, 2] },
            }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockImplementation(async (p: any) => p)

            const edit = makeEdit(
                "APPEND_ITEM",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "arr", value: 3 },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)

            const saved = repo.save.mock.calls[0][0] as any
            expect(saved.data.arr).toEqual([1, 2, 3])
        })

        it("rejects binary encoding", async () => {
            const prog = { ...entityFixtures.binary_program }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "APPEND_ITEM",
                "owner_addr_1",
                "stor-binary-789",
                { field: "arr", value: 1 },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
        })
    })

    // =========================================================================
    // DELETE_FIELD
    // =========================================================================
    describe("DELETE_FIELD", () => {
        it("deletes existing field", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: { keep: "yes", remove: "no" },
            }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockImplementation(async (p: any) => p)

            const edit = makeEdit(
                "DELETE_FIELD",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "remove" },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)

            const saved = repo.save.mock.calls[0][0] as any
            expect(saved.data.keep).toBe("yes")
            expect(saved.data.remove).toBeUndefined()
        })

        it("rejects deleting non-existent field", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: { exists: true },
            }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "DELETE_FIELD",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "nope" },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("does not exist")
        })
    })

    // =========================================================================
    // DELETE_ITEM
    // =========================================================================
    describe("DELETE_ITEM", () => {
        it("deletes item at valid index", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: { arr: ["a", "b", "c"] },
            }
            repo.findOneBy.mockResolvedValue(prog)
            repo.save.mockImplementation(async (p: any) => p)

            const edit = makeEdit(
                "DELETE_ITEM",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "arr", index: 1 },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(true)

            const saved = repo.save.mock.calls[0][0] as any
            expect(saved.data.arr).toEqual(["a", "c"])
        })

        it("rejects out of bounds index", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: { arr: [1] },
            }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "DELETE_ITEM",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "arr", index: 5 },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("rejects field that is not array", async () => {
            const prog = {
                ...entityFixtures.public_json_program,
                data: { notArr: "string" },
            }
            repo.findOneBy.mockResolvedValue(prog)

            const edit = makeEdit(
                "DELETE_ITEM",
                "owner_addr_1",
                "stor-abc123def456",
                { field: "notArr", index: 0 },
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
        })
    })

    // =========================================================================
    // Static read methods
    // =========================================================================
    describe("static read methods", () => {
        it("getStorageProgram returns null for deleted programs", async () => {
            repo.findOneBy.mockResolvedValue({
                ...entityFixtures.deleted_program,
            })

            const result = await GCRStorageProgramRoutines.getStorageProgram(
                "stor-deleted-999",
                repo as any,
            )
            expect(result).toBeNull()
        })

        it("getStorageProgram returns program for valid address", async () => {
            repo.findOneBy.mockResolvedValue({
                ...entityFixtures.public_json_program,
            })

            const result = await GCRStorageProgramRoutines.getStorageProgram(
                "stor-abc123def456",
                repo as any,
            )
            expect(result).not.toBeNull()
            expect(result?.storageAddress).toBe("stor-abc123def456")
        })

        it("getStorageProgramsByOwner owner fast-path uses repo.find with owner index", async () => {
            // When the requester IS the owner, we skip the jsonb ACL
            // predicate and rely on the existing owner index for max speed.
            repo.find.mockResolvedValue([
                entityFixtures.public_json_program,
            ])

            const results =
                await GCRStorageProgramRoutines.getStorageProgramsByOwner(
                    "owner_addr_1",
                    repo as any,
                    "owner_addr_1",
                )
            expect(results.length).toBeGreaterThan(0)
            expect(repo.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { owner: "owner_addr_1", isDeleted: false },
                }),
            )
        })

        it("getStorageProgramsByOwner anonymous goes through SQL ACL filter (not repo.find)", async () => {
            // Anonymous caller: must NOT take the owner fast-path. The
            // QueryBuilder is invoked with the public-only ACL predicate.
            const qb = makeMockQueryBuilder()
            repo.createQueryBuilder = jest.fn(() => qb) as any

            await GCRStorageProgramRoutines.getStorageProgramsByOwner(
                "owner_addr_1",
                repo as any,
            )

            expect(repo.find).not.toHaveBeenCalled()
            expect(repo.createQueryBuilder).toHaveBeenCalledWith("sp")
            // Anonymous gets the public-only branch — must contain 'public'
            // AND must NOT bind requesterAddress (the identified branch also
            // contains 'public', so a less strict assertion would pass for
            // the wrong branch).
            const hasPublicOnly = qb.andWhere.mock.calls.some(
                (c: unknown[]) =>
                    typeof c[0] === "string" &&
                    (c[0] as string).includes("'public'") &&
                    !(c[0] as string).includes(":requesterAddress"),
            )
            expect(hasPublicOnly).toBe(true)
        })

        it("getStorageProgramsByOwner non-owner requester binds requesterAddress to ACL predicate", async () => {
            const qb = makeMockQueryBuilder()
            repo.createQueryBuilder = jest.fn(() => qb) as any

            await GCRStorageProgramRoutines.getStorageProgramsByOwner(
                "owner_addr_1",
                repo as any,
                "addr_allowed_1",
            )

            // ACL predicate is added with requesterAddress bound as a
            // parameter — this protects against SQL injection.
            const aclCall = findAndWhereCall(qb, ":requesterAddress")
            expect(aclCall).toBeDefined()
            expect(aclCall?.[1]).toMatchObject({
                requesterAddress: "addr_allowed_1",
            })
        })

        it("searchStorageProgramsByName ACL-filters at SQL layer (no post-filter shortening of pages)", async () => {
            // Regression test for the post-pagination ACL bug. Even when
            // the DB page returns just one row (because the rest were
            // filtered out by the SQL ACL predicate), we should pass that
            // through unchanged — pagination is the DB's job, not JS's.
            const accessibleRow = entityFixtures.public_json_program
            const qb = makeMockQueryBuilder({
                rows: [accessibleRow],
                withPagination: true,
            })
            repo.createQueryBuilder = jest.fn(() => qb) as any

            const results =
                await GCRStorageProgramRoutines.searchStorageProgramsByName(
                    "config",
                    repo as any,
                    {
                        limit: 10,
                        offset: 0,
                        requesterAddress: "addr_allowed_1",
                    },
                )

            expect(results).toEqual([accessibleRow])
            // SQL pagination really happens (no post-filter slice).
            expect(qb.take).toHaveBeenCalledWith(10)
            expect(qb.skip).toHaveBeenCalledWith(0)
            // ACL predicate is applied with requesterAddress.
            expect(findAndWhereCall(qb, ":requesterAddress")).toBeDefined()
        })

        it("searchStorageProgramsByName anonymous receives only public branch", async () => {
            const qb = makeMockQueryBuilder({ withPagination: true })
            repo.createQueryBuilder = jest.fn(() => qb) as any

            await GCRStorageProgramRoutines.searchStorageProgramsByName(
                "config",
                repo as any,
                { limit: 10, offset: 0 },
            )

            // Anonymous SQL is just `acl->>'mode' = 'public'` — no requester
            // bind, no jsonb_each subquery for groups.
            const hasPublicOnly = qb.andWhere.mock.calls.some(
                (c: unknown[]) =>
                    typeof c[0] === "string" &&
                    (c[0] as string).includes("'public'") &&
                    !(c[0] as string).includes(":requesterAddress"),
            )
            expect(hasPublicOnly).toBe(true)
        })
    })

    // =========================================================================
    // Unknown operation
    // =========================================================================
    describe("unknown operation", () => {
        it("rejects unknown operation type", async () => {
            const edit = makeEdit(
                "UNKNOWN_OP",
                "owner",
                "stor-test",
            )

            const result = await GCRStorageProgramRoutines.apply(
                edit as any,
                repo as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("Unknown operation")
        })
    })
})
