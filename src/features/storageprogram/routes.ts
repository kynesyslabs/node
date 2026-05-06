/**
 * StorageProgram RPC Routes
 *
 * Provides HTTP endpoints for reading StorageProgram data with ACL enforcement.
 *
 * Routes:
 * - GET /storage-program/:address - Read a storage program by address
 * - GET /storage-program/owner/:owner - List storage programs by owner
 *
 * @module features/storageprogram/routes
 */

// REVIEW: StorageProgram RPC routes for unified storage access

import type { BunServer } from "@/libs/network/bunServer"
import { jsonResponse } from "@/libs/network/bunServer"
import log from "@/utilities/logger"
import Datasource from "@/model/datasource"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import { GCRStorageProgramRoutines } from "@/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"

// ============================================================================
// Response Types
// ============================================================================

/**
 * Storage program read response
 */
interface StorageProgramResponse {
    success: boolean
    storageAddress?: string
    owner?: string
    programName?: string
    encoding?: "json" | "binary"
    data?: Record<string, unknown> | string | null
    metadata?: Record<string, unknown> | null
    acl?: { mode: string; allowed?: string[]; blacklisted?: string[]; groups?: Record<string, unknown> }
    storageLocation?: string
    sizeBytes?: number
    createdAt?: string
    updatedAt?: string
    error?: string
    errorCode?:
        | "NOT_FOUND"
        | "PERMISSION_DENIED"
        | "DELETED"
        | "INTERNAL_ERROR"
        | "INVALID_REQUEST"
        | "FIELD_NOT_FOUND"
        | "INDEX_OUT_OF_BOUNDS"
        | "INVALID_FIELD_TYPE"
}

/**
 * Storage programs list response
 */
interface StorageProgramsListResponse {
    success: boolean
    programs?: Array<{
        storageAddress: string
        programName: string
        encoding: "json" | "binary"
        sizeBytes: number
        data?: Record<string, unknown> | string | null
        acl?: { mode: string; allowed?: string[]; blacklisted?: string[]; groups?: Record<string, unknown> }
        storageLocation: string
        createdAt: string
        updatedAt: string
    }>
    count?: number
    error?: string
}

interface StorageProgramGranularResponse {
    success: boolean
    storageAddress?: string
    field?: string
    fields?: string[]
    value?: unknown
    type?:
        | "string"
        | "number"
        | "boolean"
        | "array"
        | "object"
        | "null"
        | "undefined"
    index?: number
    exists?: boolean
    data?: Record<string, unknown> | string | null
    error?: string
    errorCode?:
        | "NOT_FOUND"
        | "PERMISSION_DENIED"
        | "INTERNAL_ERROR"
        | "INVALID_REQUEST"
        | "FIELD_NOT_FOUND"
        | "INDEX_OUT_OF_BOUNDS"
        | "INVALID_FIELD_TYPE"
}

/**
 * Extract the requester's address from the `identity` header.
 *
 * Identity can be either a bare address or a `prefix:address` form
 * (e.g. `ed25519:<addr>`). Returns `undefined` when:
 *   - the header is missing or empty
 *   - the post-colon segment is empty (e.g. `"ed25519:"`)
 *
 * Returning `undefined` for an empty post-colon segment is semantically
 * equivalent to anonymous in `checkReadPermission` — every branch either
 * already guards on falsy requesterAddress or compares it against a real
 * value that an empty string can't match. The change ensures consistent
 * behaviour with the SQL ACL filter and other call sites that distinguish
 * `""` from `undefined`.
 */
function getRequesterAddress(req: Request): string | undefined {
    const identity = req.headers.get("identity")
    if (!identity || identity.length === 0) {
        return undefined
    }
    const splits = identity.split(":")
    const candidate = splits.length > 1 ? splits[1] : identity
    return candidate && candidate.length > 0 ? candidate : undefined
}

function getValueType(
    value: unknown,
):
    | "string"
    | "number"
    | "boolean"
    | "array"
    | "object"
    | "null"
    | "undefined" {
    if (value === undefined) {
        return "undefined"
    }
    if (value === null) {
        return "null"
    }
    if (Array.isArray(value)) {
        return "array"
    }
    if (typeof value === "string") {
        return "string"
    }
    if (typeof value === "number") {
        return "number"
    }
    if (typeof value === "boolean") {
        return "boolean"
    }
    return "object"
}

async function getAccessibleProgram(
    storageAddress: string,
    requesterAddress?: string,
): Promise<{
    program?: GCRStorageProgram
    response?: Response
}> {
    if (!storageAddress || !storageAddress.startsWith("stor-")) {
        const response: StorageProgramResponse = {
            success: false,
            error: "Invalid storage address format. Expected: stor-{hash}",
            errorCode: "INVALID_REQUEST",
        }
        return { response: jsonResponse(response, 400) }
    }

    const db = await Datasource.getInstance()
    const repository = db.getDataSource().getRepository(GCRStorageProgram)

    const program = await GCRStorageProgramRoutines.getStorageProgram(
        storageAddress,
        repository,
    )

    if (!program) {
        const response: StorageProgramResponse = {
            success: false,
            error: `Storage program not found: ${storageAddress}`,
            errorCode: "NOT_FOUND",
        }
        return { response: jsonResponse(response, 404) }
    }

    const hasReadAccess = GCRStorageProgramRoutines.checkReadPermission(
        program,
        requesterAddress,
    )
    if (!hasReadAccess) {
        const response: StorageProgramResponse = {
            success: false,
            error: "Permission denied: You do not have read access to this storage program",
            errorCode: "PERMISSION_DENIED",
        }
        return { response: jsonResponse(response, 403) }
    }

    return { program }
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Get storage program by address
 *
 * Enforces ACL read permissions based on the requester's identity.
 * For public storage programs, anyone can read.
 * For owner/restricted, identity header is required.
 */
async function getStorageProgramHandler(req: Request): Promise<Response> {
    try {
        // Extract address from URL path
        const url = new URL(req.url)
        const pathParts = url.pathname.split("/")
        const storageAddress = pathParts[pathParts.length - 1]

        if (!storageAddress || !storageAddress.startsWith("stor-")) {
            const response: StorageProgramResponse = {
                success: false,
                error: "Invalid storage address format. Expected: stor-{hash}",
                errorCode: "INVALID_REQUEST",
            }
            return jsonResponse(response, 400)
        }

        const requesterAddress = getRequesterAddress(req)
        const result = await getAccessibleProgram(
            storageAddress,
            requesterAddress,
        )
        if (result.response) {
            return result.response
        }
        const program = result.program as GCRStorageProgram

        // Return storage program data
        const response: StorageProgramResponse = {
            success: true,
            storageAddress: program.storageAddress,
            owner: program.owner,
            programName: program.programName,
            encoding: program.encoding,
            data: program.data,
            metadata: program.metadata,
            acl: program.acl,
            storageLocation: program.storageLocation,
            sizeBytes: program.sizeBytes,
            createdAt: program.createdAt.toISOString(),
            updatedAt: program.updatedAt.toISOString(),
        }

        log.debug(
            `[StorageProgram] Read: ${storageAddress} by ${requesterAddress || "anonymous"}`,
        )
        return jsonResponse(response)
    } catch (error) {
        log.error(`[StorageProgram] Error reading storage program: ${error}`)
        const response: StorageProgramResponse = {
            success: false,
            error:
                error instanceof Error
                    ? error.message
                    : "Internal server error",
            errorCode: "INTERNAL_ERROR",
        }
        return jsonResponse(response, 500)
    }
}

async function getStorageProgramFieldsHandler(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url)
        const pathParts = url.pathname.split("/")
        const storageAddress = pathParts[2]
        const requesterAddress = getRequesterAddress(req)

        const result = await getAccessibleProgram(storageAddress, requesterAddress)
        if (result.response) {
            return result.response
        }

        const program = result.program as GCRStorageProgram
        if (!program.data || typeof program.data !== "object" || Array.isArray(program.data)) {
            const response: StorageProgramGranularResponse = {
                success: false,
                error: `Field operations are only available for JSON object data. Found: ${Array.isArray(program.data) ? "array" : typeof program.data}. Use /storage-program/:address/all to read the raw data.`,
                errorCode: "INVALID_FIELD_TYPE",
            }
            return jsonResponse(response, 400)
        }

        const response: StorageProgramGranularResponse = {
            success: true,
            storageAddress: program.storageAddress,
            fields: Object.keys(program.data as Record<string, unknown>),
        }
        return jsonResponse(response)
    } catch (error) {
        log.error(`[StorageProgram] Error fetching fields: ${error}`)
        const response: StorageProgramGranularResponse = {
            success: false,
            error: error instanceof Error ? error.message : "Internal server error",
            errorCode: "INTERNAL_ERROR",
        }
        return jsonResponse(response, 500)
    }
}

async function getStorageProgramFieldValueHandler(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url)
        const pathParts = url.pathname.split("/")
        const storageAddress = pathParts[2]
        const field = decodeURIComponent(pathParts[4] || "")
        const requesterAddress = getRequesterAddress(req)

        if (!field) {
            return jsonResponse(
                {
                    success: false,
                    error: "Field name is required",
                    errorCode: "INVALID_REQUEST",
                } satisfies StorageProgramGranularResponse,
                400,
            )
        }

        const result = await getAccessibleProgram(storageAddress, requesterAddress)
        if (result.response) {
            return result.response
        }

        const program = result.program as GCRStorageProgram
        if (!program.data || typeof program.data !== "object" || Array.isArray(program.data)) {
            return jsonResponse(
                {
                    success: false,
                    error: "Field operations are only available for JSON object data",
                    errorCode: "INVALID_FIELD_TYPE",
                } satisfies StorageProgramGranularResponse,
                400,
            )
        }

        const data = program.data as Record<string, unknown>
        if (!(field in data)) {
            return jsonResponse(
                {
                    success: false,
                    error: `Field not found: ${field}`,
                    errorCode: "FIELD_NOT_FOUND",
                } satisfies StorageProgramGranularResponse,
                404,
            )
        }

        const value = data[field]
        const response: StorageProgramGranularResponse = {
            success: true,
            storageAddress: program.storageAddress,
            field,
            value,
            type: getValueType(value),
        }
        return jsonResponse(response)
    } catch (error) {
        log.error(`[StorageProgram] Error fetching field value: ${error}`)
        return jsonResponse(
            {
                success: false,
                error: error instanceof Error ? error.message : "Internal server error",
                errorCode: "INTERNAL_ERROR",
            } satisfies StorageProgramGranularResponse,
            500,
        )
    }
}

async function getStorageProgramArrayItemHandler(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url)
        const pathParts = url.pathname.split("/")
        const storageAddress = pathParts[2]
        const field = decodeURIComponent(pathParts[4] || "")
        const indexRaw = pathParts[6]
        const index = Number.parseInt(indexRaw || "", 10)
        const requesterAddress = getRequesterAddress(req)

        if (!field || Number.isNaN(index)) {
            return jsonResponse(
                {
                    success: false,
                    error: "Field and numeric index are required",
                    errorCode: "INVALID_REQUEST",
                } satisfies StorageProgramGranularResponse,
                400,
            )
        }

        const result = await getAccessibleProgram(storageAddress, requesterAddress)
        if (result.response) {
            return result.response
        }

        const program = result.program as GCRStorageProgram
        if (!program.data || typeof program.data !== "object" || Array.isArray(program.data)) {
            return jsonResponse(
                {
                    success: false,
                    error: "Field operations are only available for JSON object data",
                    errorCode: "INVALID_FIELD_TYPE",
                } satisfies StorageProgramGranularResponse,
                400,
            )
        }

        const data = program.data as Record<string, unknown>
        if (!(field in data)) {
            return jsonResponse(
                {
                    success: false,
                    error: `Field not found: ${field}`,
                    errorCode: "FIELD_NOT_FOUND",
                } satisfies StorageProgramGranularResponse,
                404,
            )
        }

        const fieldValue = data[field]
        if (!Array.isArray(fieldValue)) {
            return jsonResponse(
                {
                    success: false,
                    error: `Field is not an array: ${field}`,
                    errorCode: "INVALID_FIELD_TYPE",
                } satisfies StorageProgramGranularResponse,
                400,
            )
        }

        if (index < 0 || index >= fieldValue.length) {
            return jsonResponse(
                {
                    success: false,
                    error: `Index out of bounds: ${index} (array length: ${fieldValue.length})`,
                    errorCode: "INDEX_OUT_OF_BOUNDS",
                } satisfies StorageProgramGranularResponse,
                400,
            )
        }

        return jsonResponse({
            success: true,
            storageAddress: program.storageAddress,
            field,
            index,
            value: fieldValue[index],
        } satisfies StorageProgramGranularResponse)
    } catch (error) {
        log.error(`[StorageProgram] Error fetching array item: ${error}`)
        return jsonResponse(
            {
                success: false,
                error: error instanceof Error ? error.message : "Internal server error",
                errorCode: "INTERNAL_ERROR",
            } satisfies StorageProgramGranularResponse,
            500,
        )
    }
}

async function hasStorageProgramFieldHandler(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url)
        const pathParts = url.pathname.split("/")
        const storageAddress = pathParts[2]
        const field = decodeURIComponent(pathParts[4] || "")
        const requesterAddress = getRequesterAddress(req)

        if (!field) {
            return jsonResponse(
                {
                    success: false,
                    error: "Field name is required",
                    errorCode: "INVALID_REQUEST",
                } satisfies StorageProgramGranularResponse,
                400,
            )
        }

        const result = await getAccessibleProgram(storageAddress, requesterAddress)
        if (result.response) {
            return result.response
        }

        const program = result.program as GCRStorageProgram
        const data =
            program.data && typeof program.data === "object" && !Array.isArray(program.data)
                ? (program.data as Record<string, unknown>)
                : null

        return jsonResponse({
            success: true,
            storageAddress: program.storageAddress,
            field,
            exists: data ? field in data : false,
        } satisfies StorageProgramGranularResponse)
    } catch (error) {
        log.error(`[StorageProgram] Error checking field existence: ${error}`)
        return jsonResponse(
            {
                success: false,
                error: error instanceof Error ? error.message : "Internal server error",
                errorCode: "INTERNAL_ERROR",
            } satisfies StorageProgramGranularResponse,
            500,
        )
    }
}

async function getStorageProgramFieldTypeHandler(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url)
        const pathParts = url.pathname.split("/")
        const storageAddress = pathParts[2]
        const field = decodeURIComponent(pathParts[4] || "")
        const requesterAddress = getRequesterAddress(req)

        if (!field) {
            return jsonResponse(
                {
                    success: false,
                    error: "Field name is required",
                    errorCode: "INVALID_REQUEST",
                } satisfies StorageProgramGranularResponse,
                400,
            )
        }

        const result = await getAccessibleProgram(storageAddress, requesterAddress)
        if (result.response) {
            return result.response
        }

        const program = result.program as GCRStorageProgram
        if (!program.data || typeof program.data !== "object" || Array.isArray(program.data)) {
            return jsonResponse(
                {
                    success: false,
                    error: "Field operations are only available for JSON object data",
                    errorCode: "INVALID_FIELD_TYPE",
                } satisfies StorageProgramGranularResponse,
                400,
            )
        }

        const data = program.data as Record<string, unknown>
        if (!(field in data)) {
            return jsonResponse(
                {
                    success: false,
                    error: `Field not found: ${field}`,
                    errorCode: "FIELD_NOT_FOUND",
                } satisfies StorageProgramGranularResponse,
                404,
            )
        }

        return jsonResponse({
            success: true,
            storageAddress: program.storageAddress,
            field,
            type: getValueType(data[field]),
        } satisfies StorageProgramGranularResponse)
    } catch (error) {
        log.error(`[StorageProgram] Error fetching field type: ${error}`)
        return jsonResponse(
            {
                success: false,
                error: error instanceof Error ? error.message : "Internal server error",
                errorCode: "INTERNAL_ERROR",
            } satisfies StorageProgramGranularResponse,
            500,
        )
    }
}

async function getStorageProgramAllDataHandler(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url)
        const pathParts = url.pathname.split("/")
        const storageAddress = pathParts[2]
        const requesterAddress = getRequesterAddress(req)

        const result = await getAccessibleProgram(storageAddress, requesterAddress)
        if (result.response) {
            return result.response
        }

        const program = result.program as GCRStorageProgram
        return jsonResponse({
            success: true,
            storageAddress: program.storageAddress,
            data: program.data,
        } satisfies StorageProgramGranularResponse)
    } catch (error) {
        log.error(`[StorageProgram] Error fetching all data: ${error}`)
        return jsonResponse(
            {
                success: false,
                error: error instanceof Error ? error.message : "Internal server error",
                errorCode: "INTERNAL_ERROR",
            } satisfies StorageProgramGranularResponse,
            500,
        )
    }
}

/**
 * List storage programs by owner
 *
 * Returns a list of storage programs owned by the specified address.
 * Only returns programs that the requester has permission to see (public or owned).
 */
async function listByOwnerHandler(req: Request): Promise<Response> {
    try {
        // Extract owner from URL path
        const url = new URL(req.url)
        const pathParts = url.pathname.split("/")
        const owner = pathParts[pathParts.length - 1]

        if (!owner) {
            const response: StorageProgramsListResponse = {
                success: false,
                error: "Owner address is required",
            }
            return jsonResponse(response, 400)
        }

        // Pagination via ?limit=&offset= — defaults match the GCR routine
        // (200 limit today, will drop to 100 in a future release).
        const rawLimit = parseInt(
            url.searchParams.get("limit") || "200",
            10,
        )
        const limit = Math.min(Math.max(1, rawLimit), 200)
        const offset = Math.max(
            0,
            parseInt(url.searchParams.get("offset") || "0", 10),
        )

        // Empty string and missing identity both map to undefined so the
        // SQL ACL filter sees a true anonymous caller (not a falsy
        // owner-bypass).
        const requesterAddress = getRequesterAddress(req)

        // Get repository
        const db = await Datasource.getInstance()
        const repository = db.getDataSource().getRepository(GCRStorageProgram)

        // ACL filtering and pagination both happen in SQL. The
        // owner-fast-path is internal: when requesterAddress === owner, the
        // routine skips the jsonb predicate and uses the owner index
        // directly.
        const accessiblePrograms =
            await GCRStorageProgramRoutines.getStorageProgramsByOwner(
                owner,
                repository,
                requesterAddress,
                { limit, offset },
            )

        // Map to response format
        const response: StorageProgramsListResponse = {
            success: true,
            programs: accessiblePrograms.map(p => ({
                storageAddress: p.storageAddress,
                programName: p.programName,
                encoding: p.encoding,
                sizeBytes: p.sizeBytes,
                data: p.data,
                acl: p.acl,
                storageLocation: p.storageLocation,
                createdAt: p.createdAt.toISOString(),
                updatedAt: p.updatedAt.toISOString(),
            })),
            count: accessiblePrograms.length,
        }

        log.debug(
            `[StorageProgram] Listed ${accessiblePrograms.length} programs for owner ${owner}`,
        )
        return jsonResponse(response)
    } catch (error) {
        log.error(`[StorageProgram] Error listing storage programs: ${error}`)
        const response: StorageProgramsListResponse = {
            success: false,
            error:
                error instanceof Error
                    ? error.message
                    : "Internal server error",
        }
        return jsonResponse(response, 500)
    }
}

/**
 * Search storage programs by name (supports partial matching)
 *
 * Query parameters:
 * - q: Search query (required)
 * - exact: If "true", performs exact match instead of partial (optional)
 * - limit: Max results to return, default 50 (optional)
 * - offset: Pagination offset, default 0 (optional)
 */
async function searchByNameHandler(req: Request): Promise<Response> {
    try {
        const url = new URL(req.url)
        const pathParts = url.pathname.split("/")
        const pathQuery = pathParts.length > 3 ? decodeURIComponent(pathParts[3]) : null
        const query = url.searchParams.get("q") || pathQuery
        const exactMatch = url.searchParams.get("exact") === "true"
        const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10)
        const limit = Math.min(Math.max(1, rawLimit), 200)
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10))

        if (!query || query.trim() === "") {
            const response: StorageProgramsListResponse = {
                success: false,
                error: "Search query 'q' parameter is required",
            }
            return jsonResponse(response, 400)
        }

        const requesterAddress = getRequesterAddress(req)

        // Get repository
        const db = await Datasource.getInstance()
        const repository = db.getDataSource().getRepository(GCRStorageProgram)

        // ACL filtering happens in SQL so LIMIT/OFFSET produce full pages
        // (no post-fetch JS filter that would silently shorten them).
        const accessiblePrograms =
            await GCRStorageProgramRoutines.searchStorageProgramsByName(
                query.trim(),
                repository,
                { limit, offset, exactMatch, requesterAddress },
            )

        // Map to response format
        const response: StorageProgramsListResponse = {
            success: true,
            programs: accessiblePrograms.map(p => ({
                storageAddress: p.storageAddress,
                programName: p.programName,
                encoding: p.encoding,
                sizeBytes: p.sizeBytes,
                data: p.data,
                acl: p.acl,
                storageLocation: p.storageLocation,
                createdAt: p.createdAt.toISOString(),
                updatedAt: p.updatedAt.toISOString(),
            })),
            count: accessiblePrograms.length,
        }

        log.debug(
            `[StorageProgram] Search "${query}" found ${accessiblePrograms.length} programs`,
        )
        return jsonResponse(response)
    } catch (error) {
        log.error(`[StorageProgram] Error searching storage programs: ${error}`)
        const response: StorageProgramsListResponse = {
            success: false,
            error:
                error instanceof Error
                    ? error.message
                    : "Internal server error",
        }
        return jsonResponse(response, 500)
    }
}

// ============================================================================
// Route Registration
// ============================================================================

/**
 * Register StorageProgram routes with BunServer
 *
 * Routes:
 * - GET /storage-program/:address - Read a storage program by address
 * - GET /storage-program/owner/:owner - List storage programs by owner
 * - GET /storage-program/search?q=name - Search storage programs by name (partial match)
 *
 * @param server - BunServer instance
 */
export function registerStorageProgramRoutes(server: BunServer): void {
    // Register specific routes first (more specific paths before wildcards)
    server.get("/storage-program/search/*", searchByNameHandler)
    server.get("/storage-program/search", searchByNameHandler)
    server.get("/storage-program/*/field/*/item/*", getStorageProgramArrayItemHandler)
    server.get("/storage-program/*/field/*", getStorageProgramFieldValueHandler)
    server.get("/storage-program/*/fields", getStorageProgramFieldsHandler)
    server.get("/storage-program/*/has/*", hasStorageProgramFieldHandler)
    server.get("/storage-program/*/type/*", getStorageProgramFieldTypeHandler)
    server.get("/storage-program/*/all", getStorageProgramAllDataHandler)
    server.get("/storage-program/owner/*", listByOwnerHandler)
    server.get("/storage-program/*", getStorageProgramHandler)

    log.info(
        "[StorageProgram] Routes registered: /storage-program/:address, /storage-program/owner/:owner, /storage-program/search, granular read endpoints",
    )
}
