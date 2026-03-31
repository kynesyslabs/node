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

// Mock datasource (not used directly in ACL checks, but imported by the module)
jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

// Load fixtures
const fixturesDir = path.join(__dirname, "../../fixtures/storageprogram")
const aclConfigs = JSON.parse(
    readFileSync(path.join(fixturesDir, "acl_configs.json"), "utf8"),
)
const entityFixtures = JSON.parse(
    readFileSync(
        path.join(fixturesDir, "storage_program_entity.json"),
        "utf8",
    ),
)

let GCRStorageProgramRoutines: typeof import("src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines")["GCRStorageProgramRoutines"]

beforeAll(async () => {
    ;({ GCRStorageProgramRoutines } = await import(
        "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
    ))
})

// Helper: build a minimal program entity for ACL testing
function makeProgram(
    acl: Record<string, unknown>,
    owner = "owner_addr_1",
) {
    return {
        ...entityFixtures.public_json_program,
        owner,
        acl,
    }
}

// checkReadPermission is a private static function; we test it indirectly
// through the route handlers. But we can test it via the getStorageProgram
// static method (which doesn't check ACL) + the public apply() method.
//
// Instead, we test ACL behavior through the GCRStorageProgramRoutines.apply
// method with a mock repository. The read permission is checked by routes,
// not by routines, but write/delete permissions are checked by routines.
//
// For a focused ACL test, we'll exercise write and delete operations with
// different ACL configs and senders, plus verify the routines correctly
// delegate permission checks.

describe("ACL permission checks via GCR operations", () => {
    let mockRepository: {
        findOneBy: jest.Mock
        find: jest.Mock
        save: jest.Mock
        createQueryBuilder: jest.Mock
    }

    beforeEach(() => {
        jest.clearAllMocks()
        mockRepository = {
            findOneBy: jest.fn(),
            find: jest.fn(),
            save: jest.fn(),
            createQueryBuilder: jest.fn(),
        }
    })

    function makeWriteEdit(sender: string, target = "stor-abc123def456") {
        return {
            target,
            type: "storageProgram",
            context: {
                operation: "WRITE_STORAGE",
                sender,
                data: {
                    variables: {
                        operation: "WRITE_STORAGE",
                        storageAddress: target,
                        data: { updated: true },
                        encoding: "json",
                    },
                },
            },
            txhash: "tx_write_test",
        }
    }

    function makeDeleteEdit(sender: string, target = "stor-abc123def456") {
        return {
            target,
            type: "storageProgram",
            context: {
                operation: "DELETE_STORAGE_PROGRAM",
                sender,
                data: {
                    variables: {
                        operation: "DELETE_STORAGE_PROGRAM",
                        storageAddress: target,
                    },
                },
            },
            txhash: "tx_delete_test",
        }
    }

    function makeSetFieldEdit(
        sender: string,
        target = "stor-abc123def456",
    ) {
        return {
            target,
            type: "storageProgram",
            context: {
                operation: "SET_FIELD",
                sender,
                data: {
                    variables: {
                        operation: "SET_FIELD",
                        storageAddress: target,
                        field: "key",
                        value: "val",
                    },
                },
            },
            txhash: "tx_setfield_test",
        }
    }

    // =========================================================================
    // WRITE permission matrix
    // =========================================================================
    describe("write permission", () => {
        it("owner can write to owner-mode program", async () => {
            const prog = makeProgram(aclConfigs.owner_mode)
            mockRepository.findOneBy.mockResolvedValue(prog)
            mockRepository.save.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("owner_addr_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(true)
        })

        it("non-owner cannot write to owner-mode program", async () => {
            const prog = makeProgram(aclConfigs.owner_mode)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("other_addr") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("No permission")
        })

        it("non-owner cannot write to public-mode program", async () => {
            const prog = makeProgram(aclConfigs.public_mode)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("other_addr") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("blacklisted cannot write to restricted program", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("addr_blacklisted_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("group writer can write to restricted program", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)
            mockRepository.save.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("addr_group_writer_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(true)
        })

        it("group reader cannot write to restricted program", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("addr_group_reader_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("allowed-list user cannot write (only read)", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_allowed)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("addr_allowed_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("group admin can write to restricted program", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)
            mockRepository.save.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("addr_group_admin_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(true)
        })
    })

    // =========================================================================
    // DELETE permission matrix
    // =========================================================================
    describe("delete permission", () => {
        it("owner can delete", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)
            mockRepository.save.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeDeleteEdit("owner_addr_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(true)
        })

        it("group with delete permission can delete", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)
            mockRepository.save.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeDeleteEdit("addr_group_admin_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(true)
        })

        it("group without delete permission cannot delete", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeDeleteEdit("addr_group_writer_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("blacklisted cannot delete", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeDeleteEdit("addr_blacklisted_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("random address cannot delete", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeDeleteEdit("random_addr") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("already deleted returns error", async () => {
            const prog = {
                ...makeProgram(aclConfigs.owner_mode),
                isDeleted: true,
            }
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeDeleteEdit("owner_addr_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("already deleted")
        })
    })

    // =========================================================================
    // Granular write permission (SET_FIELD as representative)
    // =========================================================================
    describe("granular write permission (SET_FIELD)", () => {
        it("owner can set field", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)
            mockRepository.save.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeSetFieldEdit("owner_addr_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(true)
        })

        it("group writer can set field", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)
            mockRepository.save.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeSetFieldEdit("addr_group_writer_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(true)
        })

        it("reader cannot set field", async () => {
            const prog = makeProgram(aclConfigs.restricted_with_groups)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeSetFieldEdit("addr_group_reader_1") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })
    })

    // =========================================================================
    // Null/corrupt group safety (Bug #1 + #5 regression tests)
    // =========================================================================
    describe("null/corrupt group safety", () => {
        it("handles null group entry without crashing", async () => {
            const acl = {
                mode: "restricted",
                groups: { broken: null as any },
            }
            const prog = makeProgram(acl)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("some_addr") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
            // Should not crash — just deny
        })

        it("handles group with string instead of object", async () => {
            const acl = {
                mode: "restricted",
                groups: { broken: "not-an-object" as any },
            }
            const prog = makeProgram(acl)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("some_addr") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("handles group with non-array members", async () => {
            const acl = {
                mode: "restricted",
                groups: {
                    broken: {
                        members: "not-array",
                        permissions: ["write"],
                    } as any,
                },
            }
            const prog = makeProgram(acl)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("some_addr") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })

        it("handles group with non-array permissions", async () => {
            const acl = {
                mode: "restricted",
                groups: {
                    broken: {
                        members: ["some_addr"],
                        permissions: "write",
                    } as any,
                },
            }
            const prog = makeProgram(acl)
            mockRepository.findOneBy.mockResolvedValue(prog)

            const result = await GCRStorageProgramRoutines.apply(
                makeWriteEdit("some_addr") as any,
                mockRepository as any,
                false,
            )
            expect(result.success).toBe(false)
        })
    })
})
