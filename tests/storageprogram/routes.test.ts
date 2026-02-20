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

// Create mock repository & datasource
function freshQueryBuilder() {
    const qb: Record<string, jest.Mock> = {
        where: jest.fn(),
        andWhere: jest.fn(),
        orderBy: jest.fn(),
        take: jest.fn(),
        skip: jest.fn(),
        getMany: jest.fn().mockResolvedValue([]),
    }
    qb.where.mockReturnValue(qb)
    qb.andWhere.mockReturnValue(qb)
    qb.orderBy.mockReturnValue(qb)
    qb.take.mockReturnValue(qb)
    qb.skip.mockReturnValue(qb)
    return qb
}
const mockRepository = {
    findOneBy: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(() => freshQueryBuilder()),
}
const mockDataSource = {
    getRepository: jest.fn().mockReturnValue(mockRepository),
}

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: jest.fn().mockResolvedValue({
            getDataSource: () => mockDataSource,
        }),
    },
}))

// Mock the entity import to avoid TypeORM decorator issues
jest.mock("@/model/entities/GCRv2/GCR_StorageProgram", () => ({
    __esModule: true,
    GCRStorageProgram: class GCRStorageProgram {},
}))

const fixturesDir = path.join(__dirname, "../../fixtures/storageprogram")
const rawFixtures = JSON.parse(
    readFileSync(
        path.join(fixturesDir, "storage_program_entity.json"),
        "utf8",
    ),
)

// Add Date objects to fixtures (TypeORM entities have createdAt/updatedAt as Date)
function withDates(fixture: Record<string, unknown>) {
    return {
        ...fixture,
        createdAt: new Date("2025-01-01T00:00:00Z"),
        updatedAt: new Date("2025-01-01T00:00:00Z"),
    }
}
const entityFixtures = Object.fromEntries(
    Object.entries(rawFixtures).map(([key, value]) => [
        key,
        withDates(value as Record<string, unknown>),
    ]),
)

type Handler = (req: Request) => Promise<Response>

let capturedRoutes: Map<string, Handler>

beforeAll(async () => {
    capturedRoutes = new Map()

    const mockServer = {
        get: jest.fn((path: string, handler: Handler) => {
            capturedRoutes.set(path, handler)
            return mockServer
        }),
    }

    const { registerStorageProgramRoutes } = await import(
        "src/features/storageprogram/routes"
    )
    registerStorageProgramRoutes(mockServer as any)
})

beforeEach(() => {
    jest.clearAllMocks()
    // Re-setup all mock return values after clearAllMocks
    const Datasource = require("@/model/datasource").default
    Datasource.getInstance.mockResolvedValue({
        getDataSource: () => mockDataSource,
    })
    mockDataSource.getRepository.mockReturnValue(mockRepository)
    mockRepository.createQueryBuilder.mockImplementation(() => freshQueryBuilder())
})

function makeRequest(
    urlPath: string,
    headers: Record<string, string> = {},
): Request {
    return new Request(`http://localhost:53550${urlPath}`, {
        headers: new Headers(headers),
    })
}

async function callRoute(
    pattern: string,
    urlPath: string,
    headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
    const handler = capturedRoutes.get(pattern)
    if (!handler) {
        throw new Error(`Route not found: ${pattern}. Available: ${Array.from(capturedRoutes.keys()).join(", ")}`)
    }
    const response = await handler(makeRequest(urlPath, headers))
    const body = await response.json()
    return { status: response.status, body }
}

describe("StorageProgram HTTP Routes", () => {
    // =========================================================================
    // Route registration
    // =========================================================================
    describe("route registration", () => {
        it("registers all expected routes", () => {
            const expectedPatterns = [
                "/storage-program/search/*",
                "/storage-program/search",
                "/storage-program/*/field/*/item/*",
                "/storage-program/*/field/*",
                "/storage-program/*/fields",
                "/storage-program/*/has/*",
                "/storage-program/*/type/*",
                "/storage-program/*/all",
                "/storage-program/owner/*",
                "/storage-program/*",
            ]
            for (const pattern of expectedPatterns) {
                expect(capturedRoutes.has(pattern)).toBe(true)
            }
        })
    })

    // =========================================================================
    // GET /storage-program/:address
    // =========================================================================
    describe("GET /storage-program/:address", () => {
        it("200: returns public program", async () => {
            mockRepository.findOneBy.mockResolvedValue(
                entityFixtures.public_json_program,
            )

            const { status, body } = await callRoute(
                "/storage-program/*",
                "/storage-program/stor-abc123def456",
            )
            expect(status).toBe(200)
            expect(body.success).toBe(true)
            expect(body.storageAddress).toBe("stor-abc123def456")
        })

        it("400: invalid address format", async () => {
            const { status, body } = await callRoute(
                "/storage-program/*",
                "/storage-program/invalid-addr",
            )
            expect(status).toBe(400)
            expect(body.errorCode).toBe("INVALID_REQUEST")
        })

        it("404: program not found", async () => {
            mockRepository.findOneBy.mockResolvedValue(null)

            const { status, body } = await callRoute(
                "/storage-program/*",
                "/storage-program/stor-nonexistent",
            )
            expect(status).toBe(404)
            expect(body.errorCode).toBe("NOT_FOUND")
        })

        it("403: owner-mode program without identity", async () => {
            mockRepository.findOneBy.mockResolvedValue(
                entityFixtures.owner_json_program,
            )

            const { status, body } = await callRoute(
                "/storage-program/*",
                "/storage-program/stor-owner-only-789",
            )
            expect(status).toBe(403)
            expect(body.errorCode).toBe("PERMISSION_DENIED")
        })

        it("200: owner-mode program with owner identity", async () => {
            mockRepository.findOneBy.mockResolvedValue(
                entityFixtures.owner_json_program,
            )

            const { status, body } = await callRoute(
                "/storage-program/*",
                "/storage-program/stor-owner-only-789",
                { identity: "owner_addr_1" },
            )
            expect(status).toBe(200)
            expect(body.success).toBe(true)
        })
    })

    // =========================================================================
    // GET /storage-program/owner/:owner
    // =========================================================================
    describe("GET /storage-program/owner/:owner", () => {
        it("200: returns list of programs", async () => {
            mockRepository.find.mockResolvedValue([
                entityFixtures.public_json_program,
            ])

            const { status, body } = await callRoute(
                "/storage-program/owner/*",
                "/storage-program/owner/owner_addr_1",
            )
            expect(status).toBe(200)
            expect(body.success).toBe(true)
            expect(body.programs).toBeDefined()
        })

        it("200: empty list for unknown owner", async () => {
            mockRepository.find.mockResolvedValue([])

            const { status, body } = await callRoute(
                "/storage-program/owner/*",
                "/storage-program/owner/unknown_addr",
            )
            expect(status).toBe(200)
            expect(body.programs).toEqual([])
        })
    })

    // =========================================================================
    // GET /storage-program/search
    // =========================================================================
    describe("GET /storage-program/search", () => {
        it("400: missing query parameter", async () => {
            const { status, body } = await callRoute(
                "/storage-program/search",
                "/storage-program/search",
            )
            expect(status).toBe(400)
            expect(body.error).toContain("query")
        })

        it("200: search returns results", async () => {
            const qb = freshQueryBuilder()
            qb.getMany.mockResolvedValue([entityFixtures.public_json_program])
            mockRepository.createQueryBuilder.mockReturnValue(qb)

            const { status, body } = await callRoute(
                "/storage-program/search",
                "/storage-program/search?q=test",
            )
            expect(status).toBe(200)
            expect(body.success).toBe(true)
        })

        it("caps limit at 200 (Bug #4)", async () => {
            const qb = freshQueryBuilder()
            qb.getMany.mockResolvedValue([])
            mockRepository.createQueryBuilder.mockReturnValue(qb)

            await callRoute(
                "/storage-program/search",
                "/storage-program/search?q=test&limit=99999",
            )
            // The take() call should receive capped value
            expect(qb.take).toHaveBeenCalledWith(200)
        })
    })

    // =========================================================================
    // GET /storage-program/search/:name (path alias)
    // =========================================================================
    describe("GET /storage-program/search/:name", () => {
        it("200: search via path alias", async () => {
            const qb = freshQueryBuilder()
            qb.getMany.mockResolvedValue([entityFixtures.public_json_program])
            mockRepository.createQueryBuilder.mockReturnValue(qb)

            const { status, body } = await callRoute(
                "/storage-program/search/*",
                "/storage-program/search/test-program",
            )
            expect(status).toBe(200)
            expect(body.success).toBe(true)
        })
    })

    // =========================================================================
    // GET /storage-program/:address/fields
    // =========================================================================
    describe("GET /storage-program/:address/fields", () => {
        it("200: returns field names", async () => {
            mockRepository.findOneBy.mockResolvedValue(
                entityFixtures.public_json_program,
            )

            const { status, body } = await callRoute(
                "/storage-program/*/fields",
                "/storage-program/stor-abc123def456/fields",
            )
            expect(status).toBe(200)
            expect(body.success).toBe(true)
            expect(body.fields).toBeDefined()
            expect(Array.isArray(body.fields)).toBe(true)
        })

        it("400: array data returns INVALID_FIELD_TYPE (Bug #6)", async () => {
            mockRepository.findOneBy.mockResolvedValue({
                ...entityFixtures.public_json_program,
                data: [1, 2, 3],
            })

            const { status, body } = await callRoute(
                "/storage-program/*/fields",
                "/storage-program/stor-abc123def456/fields",
            )
            expect(status).toBe(400)
            expect(body.errorCode).toBe("INVALID_FIELD_TYPE")
            expect(body.error).toContain("Found: array")
        })
    })

    // =========================================================================
    // GET /storage-program/:address/field/:field
    // =========================================================================
    describe("GET /storage-program/:address/field/:field", () => {
        it("200: returns field value", async () => {
            mockRepository.findOneBy.mockResolvedValue(
                entityFixtures.public_json_program,
            )

            const { status, body } = await callRoute(
                "/storage-program/*/field/*",
                "/storage-program/stor-abc123def456/field/name",
            )
            expect(status).toBe(200)
            expect(body.success).toBe(true)
            expect(body.value).toBeDefined()
        })

        it("404: field not found", async () => {
            mockRepository.findOneBy.mockResolvedValue(
                entityFixtures.public_json_program,
            )

            const { status, body } = await callRoute(
                "/storage-program/*/field/*",
                "/storage-program/stor-abc123def456/field/nonexistent",
            )
            expect(status).toBe(404)
            expect(body.errorCode).toBe("FIELD_NOT_FOUND")
        })
    })

    // =========================================================================
    // GET /storage-program/:address/field/:field/item/:index
    // =========================================================================
    describe("GET /storage-program/:address/field/:field/item/:index", () => {
        it("200: returns array item", async () => {
            mockRepository.findOneBy.mockResolvedValue({
                ...entityFixtures.public_json_program,
                data: { tags: ["alpha", "beta", "gamma"] },
            })

            const { status, body } = await callRoute(
                "/storage-program/*/field/*/item/*",
                "/storage-program/stor-abc123def456/field/tags/item/1",
            )
            expect(status).toBe(200)
            expect(body.value).toBe("beta")
        })

        it("400: index out of bounds", async () => {
            mockRepository.findOneBy.mockResolvedValue({
                ...entityFixtures.public_json_program,
                data: { tags: ["a"] },
            })

            const { status, body } = await callRoute(
                "/storage-program/*/field/*/item/*",
                "/storage-program/stor-abc123def456/field/tags/item/99",
            )
            expect(status).toBe(400)
            expect(body.errorCode).toBe("INDEX_OUT_OF_BOUNDS")
        })

        it("400: field not an array", async () => {
            mockRepository.findOneBy.mockResolvedValue({
                ...entityFixtures.public_json_program,
                data: { name: "not-array" },
            })

            const { status, body } = await callRoute(
                "/storage-program/*/field/*/item/*",
                "/storage-program/stor-abc123def456/field/name/item/0",
            )
            expect(status).toBe(400)
            expect(body.errorCode).toBe("INVALID_FIELD_TYPE")
        })
    })

    // =========================================================================
    // GET /storage-program/:address/has/:field
    // =========================================================================
    describe("GET /storage-program/:address/has/:field", () => {
        it("200: field exists", async () => {
            mockRepository.findOneBy.mockResolvedValue(
                entityFixtures.public_json_program,
            )

            const { status, body } = await callRoute(
                "/storage-program/*/has/*",
                "/storage-program/stor-abc123def456/has/name",
            )
            expect(status).toBe(200)
            expect(body.exists).toBe(true)
        })

        it("200: field does not exist", async () => {
            mockRepository.findOneBy.mockResolvedValue(
                entityFixtures.public_json_program,
            )

            const { status, body } = await callRoute(
                "/storage-program/*/has/*",
                "/storage-program/stor-abc123def456/has/nope",
            )
            expect(status).toBe(200)
            expect(body.exists).toBe(false)
        })
    })

    // =========================================================================
    // GET /storage-program/:address/type/:field
    // =========================================================================
    describe("GET /storage-program/:address/type/:field", () => {
        it("200: returns type for various JSON types", async () => {
            mockRepository.findOneBy.mockResolvedValue({
                ...entityFixtures.public_json_program,
                data: {
                    str: "hello",
                    num: 42,
                    arr: [1, 2],
                    obj: { a: 1 },
                    nul: null,
                    bool: true,
                },
            })

            const tests = [
                { field: "str", expected: "string" },
                { field: "num", expected: "number" },
                { field: "arr", expected: "array" },
                { field: "obj", expected: "object" },
                { field: "bool", expected: "boolean" },
            ]

            for (const t of tests) {
                const { status, body } = await callRoute(
                    "/storage-program/*/type/*",
                    `/storage-program/stor-abc123def456/type/${t.field}`,
                )
                expect(status).toBe(200)
                expect(body.type).toBe(t.expected)
            }
        })
    })

    // =========================================================================
    // GET /storage-program/:address/all
    // =========================================================================
    describe("GET /storage-program/:address/all", () => {
        it("200: returns all data", async () => {
            mockRepository.findOneBy.mockResolvedValue(
                entityFixtures.public_json_program,
            )

            const { status, body } = await callRoute(
                "/storage-program/*/all",
                "/storage-program/stor-abc123def456/all",
            )
            expect(status).toBe(200)
            expect(body.success).toBe(true)
            expect(body.data).toBeDefined()
        })

        it("403: no read access", async () => {
            mockRepository.findOneBy.mockResolvedValue(
                entityFixtures.owner_json_program,
            )

            const { status, body } = await callRoute(
                "/storage-program/*/all",
                "/storage-program/stor-owner-only-789/all",
            )
            expect(status).toBe(403)
            expect(body.errorCode).toBe("PERMISSION_DENIED")
        })
    })
})
