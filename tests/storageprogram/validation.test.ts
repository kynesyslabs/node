import { beforeAll, describe, expect, it, jest } from "@jest/globals"

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

let validateStorageProgramPayload: typeof import("src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines")["validateStorageProgramPayload"]

beforeAll(async () => {
    ;({ validateStorageProgramPayload } = await import(
        "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
    ))
})

function makePayload(overrides: Record<string, unknown> = {}) {
    return {
        operation: "CREATE_STORAGE_PROGRAM",
        storageAddress: "stor-abc123",
        programName: "test-program",
        encoding: "json" as const,
        data: { hello: "world" },
        acl: { mode: "owner" },
        ...overrides,
    }
}

describe("validateStorageProgramPayload", () => {
    // =========================================================================
    // Operation validation
    // =========================================================================
    describe("operation validation", () => {
        it("accepts valid operations", () => {
            const validOps = [
                "CREATE_STORAGE_PROGRAM",
                "WRITE_STORAGE",
                "UPDATE_ACCESS_CONTROL",
                "DELETE_STORAGE_PROGRAM",
                "SET_FIELD",
                "SET_ITEM",
                "APPEND_ITEM",
                "DELETE_FIELD",
                "DELETE_ITEM",
            ]
            for (const op of validOps) {
                const result = validateStorageProgramPayload(
                    makePayload({ operation: op }) as any,
                    "sender_addr",
                )
                // Granular ops need field/index/value, so they may fail later,
                // but should not fail on operation type
                if (!result.valid) {
                    expect(result.message).not.toContain("Invalid operation")
                }
            }
        })

        it("rejects invalid operation string", () => {
            const result = validateStorageProgramPayload(
                makePayload({ operation: "INVALID_OP" }) as any,
                "sender_addr",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("Invalid operation")
        })

        it("rejects READ_STORAGE as transaction operation", () => {
            const result = validateStorageProgramPayload(
                makePayload({ operation: "READ_STORAGE" }) as any,
                "sender_addr",
            )
            expect(result.valid).toBe(false)
        })
    })

    // =========================================================================
    // Granular operation field requirements
    // =========================================================================
    describe("granular operation requirements", () => {
        it("SET_FIELD requires field name", () => {
            const result = validateStorageProgramPayload(
                makePayload({ operation: "SET_FIELD" }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("Field name is required")
        })

        it("SET_ITEM requires index", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    operation: "SET_ITEM",
                    field: "arr",
                    value: "v",
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("Index is required")
        })

        it("SET_ITEM rejects non-numeric index", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    operation: "SET_ITEM",
                    field: "arr",
                    index: "abc",
                    value: "v",
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("Index is required")
        })

        it("APPEND_ITEM requires field", () => {
            const result = validateStorageProgramPayload(
                makePayload({ operation: "APPEND_ITEM", value: "v" }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("Field name is required")
        })

        it("DELETE_ITEM requires index", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    operation: "DELETE_ITEM",
                    field: "arr",
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("Index is required")
        })

        it("SET_FIELD requires value", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    operation: "SET_FIELD",
                    field: "key",
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("Value is required")
        })
    })

    // =========================================================================
    // Storage address format
    // =========================================================================
    describe("address format", () => {
        it("accepts valid stor- address", () => {
            const result = validateStorageProgramPayload(
                makePayload({ storageAddress: "stor-valid123" }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
        })

        it("rejects missing stor- prefix", () => {
            const result = validateStorageProgramPayload(
                makePayload({ storageAddress: "invalid-no-prefix" }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("Invalid storage address")
        })

        it("rejects empty address", () => {
            const result = validateStorageProgramPayload(
                makePayload({ storageAddress: "" }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
        })
    })

    // =========================================================================
    // CREATE specifics
    // =========================================================================
    describe("CREATE_STORAGE_PROGRAM specifics", () => {
        it("rejects missing programName", () => {
            const result = validateStorageProgramPayload(
                makePayload({ programName: undefined }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("Program name is required")
        })

        it("rejects empty programName", () => {
            const result = validateStorageProgramPayload(
                makePayload({ programName: "   " }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("Program name is required")
        })
    })

    // =========================================================================
    // Data size validation
    // =========================================================================
    describe("data size validation", () => {
        it("empty data results in 1 chunk minimum = 1 DEM", () => {
            const result = validateStorageProgramPayload(
                makePayload({ data: null }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
            expect(result.totalFee).toBe(1n)
            expect(result.breakdown?.chunks).toBe(1)
        })

        it("small data (< 10KB) = 1 chunk = 1 DEM", () => {
            const result = validateStorageProgramPayload(
                makePayload({ data: { small: "data" } }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
            expect(result.totalFee).toBe(1n)
        })

        it("10.1KB data = 2 chunks = 2 DEM", () => {
            // Create data slightly over 10KB
            const bigString = "x".repeat(10300)
            const result = validateStorageProgramPayload(
                makePayload({ data: { big: bigString } }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
            expect(result.breakdown!.chunks).toBe(2)
            expect(result.totalFee).toBe(2n)
        })

        it("rejects data exceeding 1MB", () => {
            const hugeString = "x".repeat(1048577)
            const result = validateStorageProgramPayload(
                makePayload({ data: { huge: hugeString } }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("exceeds maximum")
        })
    })

    // =========================================================================
    // JSON nesting depth
    // =========================================================================
    describe("JSON nesting depth", () => {
        function createNested(depth: number): Record<string, unknown> {
            let obj: Record<string, unknown> = { leaf: true }
            for (let i = 0; i < depth - 1; i++) {
                obj = { nested: obj }
            }
            return obj
        }

        it("accepts depth 64", () => {
            const result = validateStorageProgramPayload(
                makePayload({ data: createNested(64) }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
        })

        it("rejects depth 65", () => {
            const result = validateStorageProgramPayload(
                makePayload({ data: createNested(65) }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("nesting depth")
        })

        it("flat object = depth 1", () => {
            const result = validateStorageProgramPayload(
                makePayload({ data: { a: 1, b: 2 } }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
        })
    })

    // =========================================================================
    // Base64 validation
    // =========================================================================
    describe("base64 validation", () => {
        it("accepts valid base64", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    encoding: "binary",
                    data: "SGVsbG8gV29ybGQ=",
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
        })

        it("rejects invalid base64 characters", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    encoding: "binary",
                    data: "Not!Valid@Base64",
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("base64")
        })

        it("rejects non-padded-to-4 base64", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    encoding: "binary",
                    data: "SGVsbG8",
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
        })

        it("accepts empty base64 string", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    encoding: "binary",
                    data: "",
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
        })
    })

    // =========================================================================
    // ACL structure validation
    // =========================================================================
    describe("ACL structure validation", () => {
        it("accepts valid owner mode", () => {
            const result = validateStorageProgramPayload(
                makePayload({ acl: { mode: "owner" } }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
        })

        it("accepts valid public mode with blacklist", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    acl: { mode: "public", blacklisted: ["addr1"] },
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
        })

        it("accepts valid restricted mode with groups", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    acl: {
                        mode: "restricted",
                        groups: {
                            g1: {
                                members: ["addr1"],
                                permissions: ["read", "write"],
                            },
                        },
                    },
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
        })

        it("rejects invalid mode string", () => {
            const result = validateStorageProgramPayload(
                makePayload({ acl: { mode: "invalid" } }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("ACL mode")
        })

        it("rejects non-array allowed", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    acl: { mode: "restricted", allowed: "not-array" },
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("allowed must be an array")
        })

        it("rejects non-array blacklisted", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    acl: { mode: "public", blacklisted: "not-array" },
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
            expect(result.message).toContain("blacklisted must be an array")
        })

        it("rejects group with non-array members", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    acl: {
                        mode: "restricted",
                        groups: {
                            g1: { members: "not-array", permissions: ["read"] },
                        },
                    },
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
        })

        it("rejects group with invalid permission", () => {
            const result = validateStorageProgramPayload(
                makePayload({
                    acl: {
                        mode: "restricted",
                        groups: {
                            g1: {
                                members: ["addr1"],
                                permissions: ["invalid_perm"],
                            },
                        },
                    },
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(false)
        })
    })

    // =========================================================================
    // Fee calculation
    // =========================================================================
    describe("fee calculation", () => {
        it("empty data = 1 DEM minimum", () => {
            const result = validateStorageProgramPayload(
                makePayload({ data: null }) as any,
                "sender",
            )
            expect(result.totalFee).toBe(1n)
        })

        it("calculates correct chunks for 100KB JSON", () => {
            const data = { payload: "x".repeat(100000) }
            const result = validateStorageProgramPayload(
                makePayload({ data }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
            expect(result.breakdown!.chunks).toBe(10)
            expect(result.totalFee).toBe(10n)
        })

        it("calculates binary data size from base64", () => {
            // "SGVsbG8gV29ybGQ=" decodes to "Hello World" = 11 bytes
            const result = validateStorageProgramPayload(
                makePayload({
                    encoding: "binary",
                    data: "SGVsbG8gV29ybGQ=",
                }) as any,
                "sender",
            )
            expect(result.valid).toBe(true)
            expect(result.breakdown!.sizeBytes).toBe(11)
            expect(result.totalFee).toBe(1n)
        })
    })
})
