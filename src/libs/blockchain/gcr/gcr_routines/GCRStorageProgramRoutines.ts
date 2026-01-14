/**
 * GCR StorageProgram Routines
 *
 * Handles StorageProgram transaction validation and fee calculation
 * for the confirm/broadcast two-step transaction flow.
 *
 * @fileoverview StorageProgram GCR routines for storage operations
 */

import type { Repository } from "typeorm"
import { types, storage } from "@kynesyslabs/demosdk"

import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import log from "@/utilities/logger"
import type { GCRResult } from "../handleGCR"

// Re-export SDK types for convenience
type GCREdit = types.GCREdit
type GCREditStorageProgram = types.GCREditStorageProgram
type StorageProgramPayload = storage.StorageProgramPayload

// REVIEW: StorageProgram fee constants matching SDK
const STORAGE_PROGRAM_MAX_SIZE_BYTES = 1048576 // 1MB
const STORAGE_PROGRAM_PRICING_CHUNK_BYTES = 10240 // 10KB
const STORAGE_PROGRAM_FEE_PER_CHUNK = 1n // 1 DEM per chunk

/**
 * StorageProgram cost breakdown for confirm flow
 */
export interface StorageProgramCostBreakdown {
    /** Base cost for the operation (currently 0) */
    baseCost: bigint
    /** Storage cost based on data size */
    storageCost: bigint
    /** Data size in bytes */
    sizeBytes: number
    /** Encoding type used */
    encoding: "json" | "binary"
    /** Number of 10KB chunks */
    chunks: number
}

/**
 * Validates a StorageProgram payload and calculates fees
 *
 * @param payload - The StorageProgram payload to validate
 * @param senderAddress - The sender's address
 * @returns Validation result with fee breakdown
 */
export function validateStorageProgramPayload(
    payload: StorageProgramPayload,
    senderAddress: string,
): {
    valid: boolean
    message: string
    breakdown?: StorageProgramCostBreakdown
    totalFee?: bigint
} {
    const encoding = payload.encoding || "json"

    // Validate operation type
    // Note: READ_STORAGE is not a transaction operation - reads are handled via RPC endpoints
    const validOperations = [
        "CREATE_STORAGE_PROGRAM",
        "WRITE_STORAGE",
        "UPDATE_ACCESS_CONTROL",
        "DELETE_STORAGE_PROGRAM",
    ]
    if (!validOperations.includes(payload.operation)) {
        return {
            valid: false,
            message: `Invalid operation: ${payload.operation}`,
        }
    }

    // Validate storage address format
    if (!payload.storageAddress || !payload.storageAddress.startsWith("stor-")) {
        return {
            valid: false,
            message: "Invalid storage address format. Expected: stor-{hash}",
        }
    }

    // For CREATE, validate required fields
    if (payload.operation === "CREATE_STORAGE_PROGRAM") {
        if (!payload.programName || payload.programName.trim() === "") {
            return {
                valid: false,
                message: "Program name is required for CREATE_STORAGE_PROGRAM",
            }
        }
    }

    // Validate data if present
    let sizeBytes = 0
    if (payload.data !== undefined && payload.data !== null) {
        sizeBytes = calculateDataSize(payload.data, encoding)

        // Check size limit
        if (sizeBytes > STORAGE_PROGRAM_MAX_SIZE_BYTES) {
            return {
                valid: false,
                message: `Data size ${sizeBytes} bytes exceeds maximum ${STORAGE_PROGRAM_MAX_SIZE_BYTES} bytes (1MB)`,
            }
        }

        // For JSON encoding, validate nesting depth
        if (encoding === "json" && typeof payload.data === "object") {
            const nestingDepth = calculateJsonNestingDepth(payload.data)
            if (nestingDepth > 64) {
                return {
                    valid: false,
                    message: `JSON nesting depth ${nestingDepth} exceeds maximum 64 levels`,
                }
            }
        }

        // For binary encoding, validate base64 format
        if (encoding === "binary" && typeof payload.data === "string") {
            if (!isValidBase64(payload.data)) {
                return {
                    valid: false,
                    message: "Binary data must be valid base64 encoded string",
                }
            }
        }
    }

    // Validate ACL structure if present
    if (payload.acl) {
        const aclValidation = validateACLStructure(payload.acl)
        if (!aclValidation.valid) {
            return aclValidation
        }
    }

    // Calculate fee
    const rawChunks = Math.ceil(sizeBytes / STORAGE_PROGRAM_PRICING_CHUNK_BYTES)
    const chunks = Math.max(1, rawChunks) // Minimum 1 chunk even for empty data
    const storageCost = BigInt(chunks) * STORAGE_PROGRAM_FEE_PER_CHUNK
    const baseCost = 0n
    const totalFee = baseCost + storageCost

    const breakdown: StorageProgramCostBreakdown = {
        baseCost,
        storageCost,
        sizeBytes,
        encoding,
        chunks,
    }

    log.debug(
        `[StorageProgram] Validated ${payload.operation}: ${sizeBytes} bytes, ${chunks} chunk(s), ${totalFee} DEM fee`,
    )

    return {
        valid: true,
        message: `StorageProgram ${payload.operation} validated. Fee: ${totalFee} DEM`,
        breakdown,
        totalFee,
    }
}

/**
 * Calculate data size in bytes
 */
function calculateDataSize(
    data: Record<string, unknown> | string,
    encoding: "json" | "binary",
): number {
    if (encoding === "binary") {
        // Binary data is base64 encoded, decode to get actual size
        if (typeof data === "string") {
            // Base64 size = original_size * 4/3 (with padding)
            // Actual decoded size = length * 3/4 (minus padding)
            const padding = (data.match(/=/g) || []).length
            return Math.floor((data.length * 3) / 4) - padding
        }
        return 0
    }

    // JSON encoding - use string length
    return Buffer.byteLength(JSON.stringify(data), "utf8")
}

/**
 * Calculate JSON nesting depth recursively
 */
function calculateJsonNestingDepth(obj: unknown, currentDepth = 0): number {
    if (typeof obj !== "object" || obj === null) {
        return currentDepth
    }

    let maxDepth = currentDepth + 1

    if (Array.isArray(obj)) {
        for (const item of obj) {
            maxDepth = Math.max(maxDepth, calculateJsonNestingDepth(item, currentDepth + 1))
        }
    } else {
        for (const value of Object.values(obj)) {
            maxDepth = Math.max(maxDepth, calculateJsonNestingDepth(value, currentDepth + 1))
        }
    }

    return maxDepth
}

/**
 * Validate base64 string format
 */
function isValidBase64(str: string): boolean {
    if (str.length === 0) return true
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/
    return base64Regex.test(str) && str.length % 4 === 0
}

/**
 * Validate ACL structure
 */
function validateACLStructure(acl: unknown): { valid: boolean; message: string } {
    if (!acl || typeof acl !== "object") {
        return { valid: false, message: "ACL must be an object" }
    }

    const aclObj = acl as Record<string, unknown>

    // Validate mode
    const validModes = ["owner", "public", "restricted"]
    if (!aclObj.mode || !validModes.includes(aclObj.mode as string)) {
        return {
            valid: false,
            message: `ACL mode must be one of: ${validModes.join(", ")}`,
        }
    }

    // Validate allowed addresses if present
    if (aclObj.allowed !== undefined) {
        if (!Array.isArray(aclObj.allowed)) {
            return { valid: false, message: "ACL allowed must be an array of addresses" }
        }
        for (const addr of aclObj.allowed) {
            if (typeof addr !== "string") {
                return { valid: false, message: "ACL allowed must contain string addresses" }
            }
        }
    }

    // Validate blacklisted addresses if present
    if (aclObj.blacklisted !== undefined) {
        if (!Array.isArray(aclObj.blacklisted)) {
            return { valid: false, message: "ACL blacklisted must be an array of addresses" }
        }
        for (const addr of aclObj.blacklisted) {
            if (typeof addr !== "string") {
                return { valid: false, message: "ACL blacklisted must contain string addresses" }
            }
        }
    }

    // Validate groups if present
    if (aclObj.groups !== undefined) {
        if (typeof aclObj.groups !== "object" || aclObj.groups === null) {
            return { valid: false, message: "ACL groups must be an object" }
        }
        for (const [groupName, group] of Object.entries(aclObj.groups)) {
            // Guard against null or non-object group entries
            if (!group || typeof group !== "object") {
                return {
                    valid: false,
                    message: `ACL group ${groupName} must be an object`,
                }
            }
            const groupObj = group as Record<string, unknown>
            if (!Array.isArray(groupObj.members)) {
                return {
                    valid: false,
                    message: `ACL group ${groupName} must have members array`,
                }
            }
            if (!Array.isArray(groupObj.permissions)) {
                return {
                    valid: false,
                    message: `ACL group ${groupName} must have permissions array`,
                }
            }
            const validPermissions = ["read", "write", "delete"]
            for (const perm of groupObj.permissions) {
                if (!validPermissions.includes(perm as string)) {
                    return {
                        valid: false,
                        message: `Invalid permission ${perm} in group ${groupName}`,
                    }
                }
            }
        }
    }

    return { valid: true, message: "ACL structure valid" }
}

/**
 * GCRStorageProgramRoutines handles the storage and retrieval of StorageProgram data.
 * Programs are stored via CREATE_STORAGE_PROGRAM and WRITE_STORAGE operations.
 */
export class GCRStorageProgramRoutines {
    /**
     * Apply a StorageProgram GCR edit operation
     * @param editOperation - The GCREditStorageProgram operation
     * @param gcrStorageProgramRepository - TypeORM repository for GCRStorageProgram
     * @param simulate - If true, don't persist changes
     */
    static async apply(
        editOperation: GCREdit,
        gcrStorageProgramRepository: Repository<GCRStorageProgram>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const spEdit = editOperation as GCREditStorageProgram

        if (spEdit.type !== "storageProgram") {
            return { success: false, message: "Invalid edit type for StorageProgram" }
        }

        // SDK GCREditStorageProgram structure:
        // - target: storage address (stor-xxx)
        // - context.operation: CREATE_STORAGE_PROGRAM, WRITE_STORAGE, etc.
        // - context.sender: sender address
        // - context.data: { variables, metadata }
        const operation = spEdit.context.operation
        const storageAddress = spEdit.target

        log.info(`[StorageProgram] Processing ${operation} for ${storageAddress}`)

        switch (operation) {
            case "CREATE_STORAGE_PROGRAM": {
                return this.handleCreate(spEdit, gcrStorageProgramRepository, simulate)
            }
            case "WRITE_STORAGE": {
                return this.handleWrite(spEdit, gcrStorageProgramRepository, simulate)
            }
            case "UPDATE_ACCESS_CONTROL": {
                return this.handleUpdateAcl(spEdit, gcrStorageProgramRepository, simulate)
            }
            case "DELETE_STORAGE_PROGRAM": {
                return this.handleDelete(spEdit, gcrStorageProgramRepository, simulate)
            }
            default: {
                log.warning(`[StorageProgram] Unknown operation: ${operation}`)
                return { success: false, message: `Unknown operation: ${operation}` }
            }
        }
    }

    /**
     * Handle CREATE_STORAGE_PROGRAM operation
     *
     * SDK GCREditStorageProgram structure:
     * - target: storageAddress
     * - context.sender: owner/sender
     * - context.data.variables: StorageProgramPayload fields
     * - context.data.metadata: optional metadata
     */
    private static async handleCreate(
        edit: GCREditStorageProgram,
        repository: Repository<GCRStorageProgram>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const storageAddress = edit.target
        const sender = edit.context.sender
        const variables = edit.context.data?.variables as StorageProgramPayload | undefined

        if (!variables) {
            return { success: false, message: "Missing data.variables for create operation" }
        }

        // Check if storage program already exists
        const existing = await repository.findOneBy({ storageAddress })
        if (existing && !existing.isDeleted) {
            return {
                success: false,
                message: `Storage program already exists: ${storageAddress}`,
            }
        }

        if (simulate) {
            log.debug(`[StorageProgram] Simulated create: ${storageAddress}`)
            return { success: true, message: "Simulated create successful" }
        }

        // Calculate size and fee
        const encoding = variables.encoding || "json"
        const sizeBytes = variables.data
            ? calculateDataSize(variables.data, encoding)
            : 0
        const chunks = Math.ceil(sizeBytes / STORAGE_PROGRAM_PRICING_CHUNK_BYTES)
        const fee = BigInt(Math.max(1, chunks)) * STORAGE_PROGRAM_FEE_PER_CHUNK

        // Create new storage program
        const program = new GCRStorageProgram()
        program.storageAddress = storageAddress
        program.owner = sender
        program.programName = variables.programName || ""
        program.encoding = encoding
        program.data = variables.data || null
        program.sizeBytes = sizeBytes
        program.acl = variables.acl || { mode: "owner" }
        program.metadata = (edit.context.data?.metadata as Record<string, unknown>) || variables.metadata || null
        // REVIEW: IPFS storage location handling - stub for future implementation
        // Currently only supports "onchain" storage. IPFS integration planned for future release.
        const requestedLocation = variables.storageLocation || "onchain"
        if (requestedLocation !== "onchain") {
            log.warning(
                "[StorageProgram] IPFS storage not yet implemented. " +
                "Requested \"" + requestedLocation + "\", falling back to \"onchain\". " +
                "Address: " + storageAddress,
            )
        }
        program.storageLocation = "onchain" // Always onchain for now
        program.ipfsCid = null // IPFS CID stub - will be populated when IPFS is implemented
        program.salt = variables.salt || null
        program.createdByTx = edit.txhash
        program.lastModifiedByTx = edit.txhash
        program.totalFeesPaid = fee
        program.isDeleted = false
        program.deletedByTx = null

        await repository.save(program)
        log.info(`[StorageProgram] Created: ${storageAddress}`)

        return { success: true, message: `Storage program created: ${storageAddress}` }
    }

    /**
     * Handle WRITE_STORAGE operation
     */
    private static async handleWrite(
        edit: GCREditStorageProgram,
        repository: Repository<GCRStorageProgram>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const storageAddress = edit.target
        const variables = edit.context.data?.variables as StorageProgramPayload | undefined

        if (!variables) {
            return { success: false, message: "Missing data.variables for write operation" }
        }

        // Find existing storage program
        const program = await repository.findOneBy({ storageAddress })

        if (!program) {
            return {
                success: false,
                message: `Storage program not found: ${storageAddress}`,
            }
        }

        if (program.isDeleted) {
            return {
                success: false,
                message: `Storage program has been deleted: ${storageAddress}`,
            }
        }

        // Check write permission (owner or ACL)
        const sender = edit.context.sender
        const canWrite =
            program.owner === sender ||
            checkWritePermission(program.acl, sender)

        if (!canWrite) {
            return {
                success: false,
                message: "No permission to write to this storage program",
            }
        }

        if (simulate) {
            log.debug(`[StorageProgram] Simulated write: ${storageAddress}`)
            return { success: true, message: "Simulated write successful" }
        }

        // Calculate new size and fee
        const encoding = variables.encoding || program.encoding
        const newSizeBytes = variables.data
            ? calculateDataSize(variables.data, encoding)
            : program.sizeBytes
        const chunks = Math.ceil(newSizeBytes / STORAGE_PROGRAM_PRICING_CHUNK_BYTES)
        const fee = BigInt(Math.max(1, chunks)) * STORAGE_PROGRAM_FEE_PER_CHUNK

        // Update data
        program.data = variables.data ?? program.data
        program.sizeBytes = newSizeBytes
        program.encoding = encoding
        program.lastModifiedByTx = edit.txhash
        program.totalFeesPaid = program.totalFeesPaid + fee

        // REVIEW: IPFS storage location handling - stub for future implementation
        // Write operations cannot change storageLocation after creation (always stays "onchain" for now)
        if (variables.storageLocation && variables.storageLocation !== "onchain") {
            log.warning(
                "[StorageProgram] IPFS storage not yet implemented. " +
                "Write operation requested \"" + variables.storageLocation + "\", but storage location " +
                "cannot be changed after creation. Address: " + storageAddress,
            )
        }

        if (variables.metadata || edit.context.data?.metadata) {
            const newMetadata = (edit.context.data?.metadata as Record<string, unknown>) || variables.metadata
            program.metadata = { ...program.metadata, ...newMetadata }
        }

        await repository.save(program)
        log.info(`[StorageProgram] Updated: ${storageAddress}`)

        return { success: true, message: `Storage program updated: ${storageAddress}` }
    }

    /**
     * Handle UPDATE_ACCESS_CONTROL operation
     */
    private static async handleUpdateAcl(
        edit: GCREditStorageProgram,
        repository: Repository<GCRStorageProgram>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const storageAddress = edit.target
        const sender = edit.context.sender
        const variables = edit.context.data?.variables as StorageProgramPayload | undefined

        if (!variables?.acl) {
            return { success: false, message: "Missing acl in data.variables for updateAcl operation" }
        }

        const program = await repository.findOneBy({ storageAddress })

        if (!program) {
            return {
                success: false,
                message: `Storage program not found: ${storageAddress}`,
            }
        }

        if (program.isDeleted) {
            return {
                success: false,
                message: `Storage program has been deleted: ${storageAddress}`,
            }
        }

        // Only owner can update ACL
        if (program.owner !== sender) {
            return {
                success: false,
                message: "Only owner can update access control",
            }
        }

        if (simulate) {
            log.debug(`[StorageProgram] Simulated ACL update: ${storageAddress}`)
            return { success: true, message: "Simulated ACL update successful" }
        }

        program.acl = variables.acl
        program.lastModifiedByTx = edit.txhash

        await repository.save(program)
        log.info(`[StorageProgram] ACL updated: ${storageAddress}`)

        return { success: true, message: `ACL updated: ${storageAddress}` }
    }

    /**
     * Handle DELETE_STORAGE_PROGRAM operation (soft delete)
     */
    private static async handleDelete(
        edit: GCREditStorageProgram,
        repository: Repository<GCRStorageProgram>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const storageAddress = edit.target
        const sender = edit.context.sender

        const program = await repository.findOneBy({ storageAddress })

        if (!program) {
            return {
                success: false,
                message: `Storage program not found: ${storageAddress}`,
            }
        }

        if (program.isDeleted) {
            return {
                success: false,
                message: `Storage program already deleted: ${storageAddress}`,
            }
        }

        // Check delete permission (owner or ACL)
        const canDelete =
            program.owner === sender ||
            checkDeletePermission(program.acl, sender)

        if (!canDelete) {
            return {
                success: false,
                message: "No permission to delete this storage program",
            }
        }

        if (simulate) {
            log.debug(`[StorageProgram] Simulated delete: ${storageAddress}`)
            return { success: true, message: "Simulated delete successful" }
        }

        // Soft delete
        program.isDeleted = true
        program.deletedByTx = edit.txhash
        program.lastModifiedByTx = edit.txhash

        await repository.save(program)
        log.info(`[StorageProgram] Deleted: ${storageAddress}`)

        return { success: true, message: `Storage program deleted: ${storageAddress}` }
    }

    /**
     * Read a storage program by address
     */
    static async getStorageProgram(
        storageAddress: string,
        repository: Repository<GCRStorageProgram>,
    ): Promise<GCRStorageProgram | null> {
        const program = await repository.findOneBy({ storageAddress })
        if (program?.isDeleted) {
            return null
        }
        return program
    }

    /**
     * Get all storage programs owned by an address
     */
    static async getStorageProgramsByOwner(
        owner: string,
        repository: Repository<GCRStorageProgram>,
    ): Promise<GCRStorageProgram[]> {
        return repository.find({
            where: { owner, isDeleted: false },
            order: { createdAt: "DESC" },
        })
    }


    /**
     * Check if an address has read permission for a storage program
     * @param program - The storage program to check
     * @param requesterAddress - The address requesting read access (optional for public data)
     * @returns true if read is allowed, false otherwise
     */
    static checkReadPermission(
        program: GCRStorageProgram,
        requesterAddress?: string,
    ): boolean {
        const acl = program.acl

        // Public mode - everyone can read
        if (acl.mode === "public") {
            // Still check blacklist for public mode
            if (requesterAddress && acl.blacklisted?.includes(requesterAddress)) {
                return false
            }
            return true
        }

        // Owner mode - only owner can read
        if (acl.mode === "owner") {
            return requesterAddress === program.owner
        }

        // Restricted mode - check allowed list and groups
        if (acl.mode === "restricted") {
            // No requester means anonymous - denied in restricted mode
            if (!requesterAddress) {
                return false
            }

            // Owner always has access (check BEFORE blacklist - owner cannot be blacklisted)
            if (requesterAddress === program.owner) {
                return true
            }

            // Check blacklist
            if (acl.blacklisted?.includes(requesterAddress)) {
                return false
            }

            // Check allowed list
            if (acl.allowed?.includes(requesterAddress)) {
                return true
            }

            // Check groups for read permission
            if (acl.groups) {
                for (const group of Object.values(acl.groups)) {
                    if (
                        group.members.includes(requesterAddress) &&
                        group.permissions.includes("read")
                    ) {
                        return true
                    }
                }
            }

            return false
        }

        // Unknown mode - deny by default
        return false
    }
}

/**
 * Check if address has delete permission in ACL
 */
function checkDeletePermission(
    acl: { mode: string; allowed?: string[]; blacklisted?: string[]; groups?: Record<string, { members: string[]; permissions: string[] }> },
    address: string,
): boolean {
    // Check blacklist first
    if (acl.blacklisted?.includes(address)) {
        return false
    }

    // Check groups
    if (acl.groups) {
        for (const group of Object.values(acl.groups)) {
            if (group.members.includes(address) && group.permissions.includes("delete")) {
                return true
            }
        }
    }

    return false
}

/**
 * Check if address has write permission in ACL
 */
function checkWritePermission(
    acl: { mode: string; allowed?: string[]; blacklisted?: string[]; groups?: Record<string, { members: string[]; permissions: string[] }> },
    address: string,
): boolean {
    // Check blacklist first
    if (acl.blacklisted?.includes(address)) {
        return false
    }

    // Public mode allows anyone to write (if not blacklisted)
    if (acl.mode === "public") {
        return true
    }

    // Check groups for write permission
    if (acl.groups) {
        for (const group of Object.values(acl.groups)) {
            if (group.members.includes(address) && group.permissions.includes("write")) {
                return true
            }
        }
    }

    return false
}
