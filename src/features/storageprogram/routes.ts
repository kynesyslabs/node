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
    storageLocation?: string
    sizeBytes?: number
    createdAt?: string
    updatedAt?: string
    error?: string
    errorCode?: "NOT_FOUND" | "PERMISSION_DENIED" | "DELETED" | "INTERNAL_ERROR"
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
        storageLocation: string
        createdAt: string
        updatedAt: string
    }>
    count?: number
    error?: string
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
                errorCode: "NOT_FOUND",
            }
            return jsonResponse(response, 400)
        }

        // Get requester identity from header (optional for public programs)
        const identity = req.headers.get("identity")
        let requesterAddress: string | undefined

        if (identity) {
            // Parse identity header (format: algorithm:publicKey or just publicKey)
            const splits = identity.split(":")
            requesterAddress = splits.length > 1 ? splits[1] : identity
        }

        // Get repository
        const db = await Datasource.getInstance()
        const repository = db.getDataSource().getRepository(GCRStorageProgram)

        // Fetch storage program
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
            return jsonResponse(response, 404)
        }

        // Check read permission
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
            return jsonResponse(response, 403)
        }

        // Return storage program data
        const response: StorageProgramResponse = {
            success: true,
            storageAddress: program.storageAddress,
            owner: program.owner,
            programName: program.programName,
            encoding: program.encoding,
            data: program.data,
            metadata: program.metadata,
            storageLocation: program.storageLocation,
            sizeBytes: program.sizeBytes,
            createdAt: program.createdAt.toISOString(),
            updatedAt: program.updatedAt.toISOString(),
        }

        log.debug(`[StorageProgram] Read: ${storageAddress} by ${requesterAddress || "anonymous"}`)
        return jsonResponse(response)
    } catch (error) {
        log.error(`[StorageProgram] Error reading storage program: ${error}`)
        const response: StorageProgramResponse = {
            success: false,
            error: error instanceof Error ? error.message : "Internal server error",
            errorCode: "INTERNAL_ERROR",
        }
        return jsonResponse(response, 500)
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

        // Get requester identity from header
        const identity = req.headers.get("identity")
        let requesterAddress: string | undefined

        if (identity) {
            const splits = identity.split(":")
            requesterAddress = splits.length > 1 ? splits[1] : identity
        }

        // Get repository
        const db = await Datasource.getInstance()
        const repository = db.getDataSource().getRepository(GCRStorageProgram)

        // Fetch all programs by owner
        const programs = await GCRStorageProgramRoutines.getStorageProgramsByOwner(
            owner,
            repository,
        )

        // Filter to only programs the requester can read
        const accessiblePrograms = programs.filter(program =>
            GCRStorageProgramRoutines.checkReadPermission(program, requesterAddress),
        )

        // Map to response format (without full data for list view)
        const response: StorageProgramsListResponse = {
            success: true,
            programs: accessiblePrograms.map(p => ({
                storageAddress: p.storageAddress,
                programName: p.programName,
                encoding: p.encoding,
                sizeBytes: p.sizeBytes,
                storageLocation: p.storageLocation,
                createdAt: p.createdAt.toISOString(),
                updatedAt: p.updatedAt.toISOString(),
            })),
            count: accessiblePrograms.length,
        }

        log.debug(`[StorageProgram] Listed ${accessiblePrograms.length} programs for owner ${owner}`)
        return jsonResponse(response)
    } catch (error) {
        log.error(`[StorageProgram] Error listing storage programs: ${error}`)
        const response: StorageProgramsListResponse = {
            success: false,
            error: error instanceof Error ? error.message : "Internal server error",
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
 *
 * @param server - BunServer instance
 */
export function registerStorageProgramRoutes(server: BunServer): void {
    // Read storage program by address
    // Note: BunServer uses pattern matching, so we register the specific route
    server.get("/storage-program/owner/*", listByOwnerHandler)
    server.get("/storage-program/*", getStorageProgramHandler)

    log.info("[StorageProgram] Routes registered: /storage-program/:address, /storage-program/owner/:owner")
}
