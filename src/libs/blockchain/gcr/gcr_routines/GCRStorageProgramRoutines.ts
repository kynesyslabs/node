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
import {
    isJsonbStorable,
    NOT_STORABLE,
} from "@/libs/blockchain/validation/postgresStorable"
import type { GCRResult } from "../handleGCR"

// Re-export SDK types for convenience
type GCREdit = types.GCREdit
type GCREditStorageProgram = types.GCREditStorageProgram
type StorageProgramPayload = storage.StorageProgramPayload

// REVIEW: StorageProgram fee constants matching SDK
const STORAGE_PROGRAM_MAX_SIZE_BYTES = 1048576 // 1MB
const STORAGE_PROGRAM_PRICING_CHUNK_BYTES = 10240 // 10KB
const STORAGE_PROGRAM_FEE_PER_CHUNK = 1n // 1 DEM per chunk
const MAX_INTERACTION_TXS = 1000
const STORAGE_NOT_STORABLE = `Storage program payload ${NOT_STORABLE}`

function deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
): Record<string, unknown> {
    const result = { ...target }
    for (const key of Object.keys(source)) {
        const tVal = target[key]
        const sVal = source[key]
        if (
            tVal && sVal &&
            typeof tVal === "object" && !Array.isArray(tVal) &&
            typeof sVal === "object" && !Array.isArray(sVal)
        ) {
            result[key] = deepMerge(
                tVal as Record<string, unknown>,
                sVal as Record<string, unknown>,
            )
        } else {
            result[key] = sVal
        }
    }
    return result
}

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

    if (!isJsonbStorable(payload)) {
        return {
            valid: false,
            message: STORAGE_NOT_STORABLE,
        }
    }

    // Validate operation type
    // Note: READ_STORAGE is not a transaction operation - reads are handled via RPC endpoints
    const validOperations = [
        "CREATE_STORAGE_PROGRAM",
        "WRITE_STORAGE",
        "UPDATE_ACCESS_CONTROL",
        "DELETE_STORAGE_PROGRAM",
        // REVIEW: Granular field operations (JSON encoding only)
        "SET_FIELD",
        "SET_ITEM",
        "APPEND_ITEM",
        "DELETE_FIELD",
        "DELETE_ITEM",
    ]
    if (!validOperations.includes(payload.operation)) {
        return {
            valid: false,
            message: `Invalid operation: ${payload.operation}`,
        }
    }

    // Granular operations require field name and JSON encoding
    const granularOperations = [
        "SET_FIELD",
        "SET_ITEM",
        "APPEND_ITEM",
        "DELETE_FIELD",
        "DELETE_ITEM",
    ]
    if (granularOperations.includes(payload.operation)) {
        // Validate field name is present
        const payloadWithField = payload as StorageProgramPayload & {
            field?: string
            index?: number
            value?: unknown
        }
        if (
            !payloadWithField.field ||
            typeof payloadWithField.field !== "string"
        ) {
            return {
                valid: false,
                message: `Field name is required for ${payload.operation} operation`,
            }
        }

        // SET_ITEM and DELETE_ITEM require index
        if (
            (payload.operation === "SET_ITEM" ||
                payload.operation === "DELETE_ITEM") &&
            (payloadWithField.index === undefined ||
                typeof payloadWithField.index !== "number")
        ) {
            return {
                valid: false,
                message: `Index is required for ${payload.operation} operation`,
            }
        }

        // SET_FIELD, SET_ITEM, and APPEND_ITEM require value
        if (
            (payload.operation === "SET_FIELD" ||
                payload.operation === "SET_ITEM" ||
                payload.operation === "APPEND_ITEM") &&
            payloadWithField.value === undefined
        ) {
            return {
                valid: false,
                message: `Value is required for ${payload.operation} operation`,
            }
        }
    }

    // Validate storage address format
    if (
        !payload.storageAddress ||
        !payload.storageAddress.startsWith("stor-")
    ) {
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
 * Field names a granular operation refuses: assigning one reaches the
 * object's prototype instead of storing a field.
 */
const RESERVED_FIELD_NAMES = new Set(["__proto__"])

type GranularVariables = StorageProgramPayload & {
    field: string
    index?: number
    value?: unknown
}

/**
 * The object whose JSON size prices a granular write: the field with the
 * written value, as an array element for the array operations. It bounds the
 * growth the write can cause. The SDK prices the transaction's burn edit
 * with the same object, so the fee recorded here is the fee burned.
 */
export function granularWriteFootprint(
    variables: Pick<GranularVariables, "operation" | "field" | "value">,
): Record<string, unknown> {
    const field = String(variables.field ?? "")
    const value =
        variables.operation === "SET_FIELD" ? variables.value : [variables.value]
    return { [field]: value }
}

/** 1 DEM per started 10KB of the write's footprint, as the SDK burns it. */
export function granularWriteFee(
    variables: Pick<GranularVariables, "operation" | "field" | "value">,
): bigint {
    const sizeBytes = calculateDataSize(granularWriteFootprint(variables), "json")
    const chunks = Math.ceil(sizeBytes / STORAGE_PROGRAM_PRICING_CHUNK_BYTES)
    return BigInt(Math.max(1, chunks)) * STORAGE_PROGRAM_FEE_PER_CHUNK
}

function ownField(data: Record<string, unknown>, field: string): unknown {
    return Object.hasOwn(data, field) ? data[field] : undefined
}

/** The array field an item operation names and the position it resolves to. */
function granularItem(
    data: Record<string, unknown>,
    variables: GranularVariables,
): { error: GCRResult } | { items: unknown[]; index: number } {
    const items = ownField(data, variables.field)
    if (!Array.isArray(items)) {
        return {
            error: {
                success: false,
                message: `Field ${variables.field} is not an array`,
            },
        }
    }
    const index = resolveIndex(variables.index, items.length)
    if (index === null) {
        return {
            error: {
                success: false,
                message: `Index ${variables.index} out of bounds for array ${variables.field} (length: ${items.length})`,
            },
        }
    }
    return { items, index }
}

/** A whole index into an array of `length`, negative counting from the end. */
function resolveIndex(index: unknown, length: number): number | null {
    if (typeof index !== "number" || !Number.isInteger(index)) return null
    const resolved = index < 0 ? length + index : index
    return resolved >= 0 && resolved < length ? resolved : null
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
            maxDepth = Math.max(
                maxDepth,
                calculateJsonNestingDepth(item, currentDepth + 1),
            )
        }
    } else {
        for (const value of Object.values(obj)) {
            maxDepth = Math.max(
                maxDepth,
                calculateJsonNestingDepth(value, currentDepth + 1),
            )
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
function validateACLStructure(acl: unknown): {
    valid: boolean
    message: string
} {
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
            return {
                valid: false,
                message: "ACL allowed must be an array of addresses",
            }
        }
        for (const addr of aclObj.allowed) {
            if (typeof addr !== "string") {
                return {
                    valid: false,
                    message: "ACL allowed must contain string addresses",
                }
            }
        }
    }

    // Validate blacklisted addresses if present
    if (aclObj.blacklisted !== undefined) {
        if (!Array.isArray(aclObj.blacklisted)) {
            return {
                valid: false,
                message: "ACL blacklisted must be an array of addresses",
            }
        }
        for (const addr of aclObj.blacklisted) {
            if (typeof addr !== "string") {
                return {
                    valid: false,
                    message: "ACL blacklisted must contain string addresses",
                }
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
     * @param program - The in-memory GCRStorageProgram entity (null for CREATE)
     * @param simulate - If true, don't mutate the entity
     */
    static async apply(
        editOperation: GCREdit,
        program: GCRStorageProgram | null,
        simulate: boolean,
    ): Promise<GCRResult> {
        const spEdit = editOperation as GCREditStorageProgram

        if (spEdit.type !== "storageProgram") {
            return {
                success: false,
                message: "Invalid edit type for StorageProgram",
            }
        }

        // SDK GCREditStorageProgram structure:
        // - target: storage address (stor-xxx)
        // - context.operation: CREATE_STORAGE_PROGRAM, WRITE_STORAGE, etc.
        // - context.sender: sender address
        // - context.data: { variables, metadata }
        const operation = spEdit.context.operation
        const storageAddress = spEdit.target

        log.info(
            `[StorageProgram] Processing ${operation} for ${storageAddress}`,
        )

        switch (operation) {
            case "CREATE_STORAGE_PROGRAM": {
                return this.handleCreate(
                    spEdit,
                    program,
                    simulate,
                )
            }
            case "WRITE_STORAGE": {
                return this.handleWrite(
                    spEdit,
                    program,
                    simulate,
                )
            }
            case "UPDATE_ACCESS_CONTROL": {
                return this.handleUpdateAcl(
                    spEdit,
                    program,
                    simulate,
                )
            }
            case "DELETE_STORAGE_PROGRAM": {
                return this.handleDelete(
                    spEdit,
                    program,
                    simulate,
                )
            }
            // REVIEW: Granular field operations
            case "SET_FIELD": {
                return this.handleSetField(
                    spEdit,
                    program,
                    simulate,
                )
            }
            case "SET_ITEM": {
                return this.handleSetItem(
                    spEdit,
                    program,
                    simulate,
                )
            }
            case "APPEND_ITEM": {
                return this.handleAppendItem(
                    spEdit,
                    program,
                    simulate,
                )
            }
            case "DELETE_FIELD": {
                return this.handleDeleteField(
                    spEdit,
                    program,
                    simulate,
                )
            }
            case "DELETE_ITEM": {
                return this.handleDeleteItem(
                    spEdit,
                    program,
                    simulate,
                )
            }
            default: {
                log.warning(`[StorageProgram] Unknown operation: ${operation}`)
                return {
                    success: false,
                    message: `Unknown operation: ${operation}`,
                }
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
        program: GCRStorageProgram | null,
        simulate: boolean,
    ): Promise<GCRResult> {
        const storageAddress = edit.target
        const sender = edit.context.sender
        const variables = edit.context.data?.variables as
            | StorageProgramPayload
            | undefined

        if (!variables) {
            return {
                success: false,
                message: "Missing data.variables for create operation",
            }
        }

        // Check if storage program already exists
        if (program && !program.isDeleted) {
            return {
                success: false,
                message: `Storage program already exists: ${storageAddress}`,
            }
        }

        // Calculate size and fee (validate before simulate to catch invalid payloads early)
        const encoding = variables.encoding || "json"
        const sizeBytes = variables.data
            ? calculateDataSize(variables.data, encoding)
            : 0

        if (sizeBytes > STORAGE_PROGRAM_MAX_SIZE_BYTES) {
            return {
                success: false,
                message: `Data size ${sizeBytes} bytes exceeds maximum ${STORAGE_PROGRAM_MAX_SIZE_BYTES} bytes (1MB)`,
            }
        }

        if (encoding === "json" && variables.data && typeof variables.data === "object") {
            const depth = calculateJsonNestingDepth(variables.data)
            if (depth > 64) {
                return {
                    success: false,
                    message: `JSON nesting depth ${depth} exceeds maximum 64 levels`,
                }
            }
        }

        if (encoding === "binary" && typeof variables.data === "string" && !isValidBase64(variables.data)) {
            return {
                success: false,
                message: "Binary data must be valid base64 encoded string",
            }
        }

        const chunks = Math.ceil(
            sizeBytes / STORAGE_PROGRAM_PRICING_CHUNK_BYTES,
        )
        const fee = BigInt(Math.max(1, chunks)) * STORAGE_PROGRAM_FEE_PER_CHUNK

        if (simulate) {
            log.debug(`[StorageProgram] Simulated create: ${storageAddress}`)
            return { success: true, message: "Simulated create successful" }
        }

        // Create new storage program in-memory
        program = new GCRStorageProgram()
        program.storageAddress = storageAddress
        program.owner = sender
        program.programName = variables.programName || ""
        program.encoding = encoding
        program.data = variables.data || null
        program.sizeBytes = sizeBytes
        program.acl = variables.acl || { mode: "owner" }
        program.metadata =
            (edit.context.data?.metadata as Record<string, unknown>) ||
            variables.metadata ||
            null
        // REVIEW: IPFS storage location handling - stub for future implementation
        // Currently only supports "onchain" storage. IPFS integration planned for future release.
        const requestedLocation = variables.storageLocation || "onchain"
        if (requestedLocation !== "onchain") {
            log.warning(
                "[StorageProgram] IPFS storage not yet implemented. " +
                    "Requested \"" +
                    requestedLocation +
                    "\", falling back to \"onchain\". " +
                    "Address: " +
                    storageAddress,
            )
        }
        program.storageLocation = "onchain" // Always onchain for now
        program.ipfsCid = null // IPFS CID stub - will be populated when IPFS is implemented
        program.salt = variables.salt || null
        program.createdByTx = edit.txhash
        program.lastModifiedByTx = edit.txhash
        program.interactionTxs = [edit.txhash]
        program.totalFeesPaid = fee
        program.isDeleted = false
        program.deletedByTx = null

        log.info(`[StorageProgram] Created: ${storageAddress}`)

        return {
            success: true,
            message: `Storage program created: ${storageAddress}`,
            storageProgram: program,
        }
    }

    /**
     * Handle WRITE_STORAGE operation
     */
    private static async handleWrite(
        edit: GCREditStorageProgram,
        program: GCRStorageProgram | null,
        simulate: boolean,
    ): Promise<GCRResult> {
        const storageAddress = edit.target
        const variables = edit.context.data?.variables as
            | StorageProgramPayload
            | undefined

        if (!variables) {
            return {
                success: false,
                message: "Missing data.variables for write operation",
            }
        }

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

        // Calculate new size and fee (validate before simulate to catch invalid payloads early)
        const encoding = variables.encoding || program.encoding
        const newSizeBytes = variables.data
            ? calculateDataSize(variables.data, encoding)
            : program.sizeBytes

        if (newSizeBytes > STORAGE_PROGRAM_MAX_SIZE_BYTES) {
            return {
                success: false,
                message: `Data size ${newSizeBytes} bytes exceeds maximum ${STORAGE_PROGRAM_MAX_SIZE_BYTES} bytes (1MB)`,
            }
        }

        if (encoding === "json" && variables.data && typeof variables.data === "object") {
            const depth = calculateJsonNestingDepth(variables.data)
            if (depth > 64) {
                return {
                    success: false,
                    message: `JSON nesting depth ${depth} exceeds maximum 64 levels`,
                }
            }
        }

        if (encoding === "binary" && typeof variables.data === "string" && !isValidBase64(variables.data)) {
            return {
                success: false,
                message: "Binary data must be valid base64 encoded string",
            }
        }

        const chunks = Math.ceil(
            newSizeBytes / STORAGE_PROGRAM_PRICING_CHUNK_BYTES,
        )
        const fee = BigInt(Math.max(1, chunks)) * STORAGE_PROGRAM_FEE_PER_CHUNK

        if (simulate) {
            log.debug(`[StorageProgram] Simulated write: ${storageAddress}`)
            return { success: true, message: "Simulated write successful" }
        }

        // Update data in-place
        program.data = variables.data ?? program.data
        program.sizeBytes = newSizeBytes
        program.encoding = encoding
        program.lastModifiedByTx = edit.txhash
        program.interactionTxs = [
            ...(program.interactionTxs || []).slice(-(MAX_INTERACTION_TXS - 1)),
            edit.txhash,
        ]
        program.totalFeesPaid = program.totalFeesPaid + fee

        // REVIEW: IPFS storage location handling - stub for future implementation
        // Write operations cannot change storageLocation after creation (always stays "onchain" for now)
        if (
            variables.storageLocation &&
            variables.storageLocation !== "onchain"
        ) {
            log.warning(
                "[StorageProgram] IPFS storage not yet implemented. " +
                    "Write operation requested \"" +
                    variables.storageLocation +
                    "\", but storage location " +
                    "cannot be changed after creation. Address: " +
                    storageAddress,
            )
        }

        if (variables.metadata || edit.context.data?.metadata) {
            const newMetadata =
                (edit.context.data?.metadata as Record<string, unknown>) ||
                variables.metadata
            program.metadata = deepMerge(
                (program.metadata || {}) as Record<string, unknown>,
                newMetadata as Record<string, unknown>,
            )
        }

        log.info(`[StorageProgram] Updated: ${storageAddress}`)

        return {
            success: true,
            message: `Storage program updated: ${storageAddress}`,
            storageProgram: program,
        }
    }

    /**
     * Handle UPDATE_ACCESS_CONTROL operation
     */
    private static async handleUpdateAcl(
        edit: GCREditStorageProgram,
        program: GCRStorageProgram | null,
        simulate: boolean,
    ): Promise<GCRResult> {
        const storageAddress = edit.target
        const sender = edit.context.sender
        const variables = edit.context.data?.variables as
            | StorageProgramPayload
            | undefined

        if (!variables?.acl) {
            return {
                success: false,
                message:
                    "Missing acl in data.variables for updateAcl operation",
            }
        }

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
            log.debug(
                `[StorageProgram] Simulated ACL update: ${storageAddress}`,
            )
            return { success: true, message: "Simulated ACL update successful" }
        }

        program.acl = variables.acl
        program.lastModifiedByTx = edit.txhash
        program.interactionTxs = [
            ...(program.interactionTxs || []).slice(-(MAX_INTERACTION_TXS - 1)),
            edit.txhash,
        ]

        log.info(`[StorageProgram] ACL updated: ${storageAddress}`)

        return {
            success: true,
            message: `ACL updated: ${storageAddress}`,
            storageProgram: program,
        }
    }

    /**
     * Handle DELETE_STORAGE_PROGRAM operation (soft delete)
     */
    private static async handleDelete(
        edit: GCREditStorageProgram,
        program: GCRStorageProgram | null,
        simulate: boolean,
    ): Promise<GCRResult> {
        const storageAddress = edit.target
        const sender = edit.context.sender

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

        // Soft delete in-place
        program.isDeleted = true
        program.deletedByTx = edit.txhash
        program.lastModifiedByTx = edit.txhash
        program.interactionTxs = [
            ...(program.interactionTxs || []).slice(-(MAX_INTERACTION_TXS - 1)),
            edit.txhash,
        ]

        log.info(`[StorageProgram] Deleted: ${storageAddress}`)

        return {
            success: true,
            message: `Storage program deleted: ${storageAddress}`,
            storageProgram: program,
        }
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
     * SQL predicate that mirrors {@link checkReadPermission} at the database
     * layer. Evaluated against the alias `sp` (storage program) row.
     *
     * Produces an `(SQL, parameters)` pair the caller `.andWhere()`s into a
     * QueryBuilder, so ACL filtering happens before LIMIT/OFFSET and pages
     * stay full. Without this, post-fetch JS filtering produced short pages
     * and silently hid accessible rows past the SQL window.
     *
     * Branches (all expressed as jsonb containment so they map to the natural
     * Postgres operators and don't require value normalisation):
     *   - public mode and not blacklisted (anonymous always sees public —
     *     blacklist needs an identity to test)
     *   - owner mode and requester is the owner
     *   - restricted mode and requester is the owner (owner overrides
     *     blacklist; matches checkReadPermission line 1006-1009)
     *   - restricted mode and requester is in `acl.allowed` and not in
     *     `acl.blacklisted`
     *   - restricted mode and requester is a member of a group whose
     *     `permissions` array contains "read", and not blacklisted
     *
     * Uses jsonb `@>` containment so Postgres can short-circuit on absent
     * keys; no GIN index is required because the query is already gated by
     * `programName ILIKE` / `owner` / `isDeleted` predicates that prune the
     * candidate set heavily before this predicate runs.
     */
    private static readReachablePredicate(
        requesterAddress: string | undefined,
        alias = "sp",
    ): { sql: string; params: Record<string, unknown> } {
        // Normalize empty-string requester to undefined so this primitive
        // matches checkReadPermission's anonymous semantics (every branch
        // there treats falsy requesterAddress as anonymous via falsy
        // checks). All current callers already gate on .length > 0, so
        // this is defense-in-depth — but the function should be
        // self-protecting against future callers.
        const r =
            typeof requesterAddress === "string" &&
            requesterAddress.length > 0
                ? requesterAddress
                : undefined

        // Defense-in-depth: alias is interpolated directly into SQL, so
        // reject anything outside a normal SQL identifier shape. Today the
        // only caller uses the default "sp", but a future caller passing
        // user-derived input would otherwise be a SQL-injection vector.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
            throw new Error(
                `Invalid SQL alias for readReachablePredicate: ${alias}`,
            )
        }
        const a = alias
        if (r === undefined) {
            // Anonymous: only public programs are visible. Blacklist applies
            // only to identified callers (we have no identity to test
            // against), matching checkReadPermission.
            return {
                sql: `(${a}.acl->>'mode' = 'public')`,
                params: {},
            }
        }
        return {
            sql: `(
                -- public mode, requester not in blacklist
                (${a}.acl->>'mode' = 'public'
                  AND NOT COALESCE(${a}.acl->'blacklisted' @> to_jsonb(:requesterAddress::text), false))
                -- owner mode, requester is the owner
                OR (${a}.acl->>'mode' = 'owner' AND ${a}.owner = :requesterAddress)
                -- restricted mode, requester is the owner (owner overrides blacklist)
                OR (${a}.acl->>'mode' = 'restricted' AND ${a}.owner = :requesterAddress)
                -- restricted mode, requester is in allowed list and not blacklisted
                OR (${a}.acl->>'mode' = 'restricted'
                    AND ${a}.acl->'allowed' @> to_jsonb(:requesterAddress::text)
                    AND NOT COALESCE(${a}.acl->'blacklisted' @> to_jsonb(:requesterAddress::text), false))
                -- restricted mode, requester is a member of a group with read permission
                -- jsonb_typeof guard avoids "cannot call jsonb_each on a non-object"
                -- when acl.groups is missing/null/non-object (allowed by the schema —
                -- StorageProgramACL.groups is optional)
                OR (${a}.acl->>'mode' = 'restricted'
                    AND NOT COALESCE(${a}.acl->'blacklisted' @> to_jsonb(:requesterAddress::text), false)
                    AND jsonb_typeof(${a}.acl->'groups') = 'object'
                    AND EXISTS (
                        SELECT 1 FROM jsonb_each(${a}.acl->'groups') AS grp(name, def)
                        WHERE def->'members' @> to_jsonb(:requesterAddress::text)
                          AND def->'permissions' @> '"read"'::jsonb
                    ))
            )`,
            params: { requesterAddress: r },
        }
    }

    /**
     * Get storage programs owned by an address, ACL-filtered for the
     * requester and paginated at the SQL layer.
     *
     * When `requesterAddress` matches `owner`, ACL filtering is skipped (the
     * owner sees everything, hits only the existing owner index). For any
     * other requester, the SQL ACL predicate runs at the database layer.
     *
     * **Pagination:** SQL LIMIT/OFFSET are always applied to avoid
     * materialising the full result set in memory for owners with many
     * programs. `options.limit` defaults to **200** today and is clamped
     * to [1, 200].
     *
     * **Default limit will drop to 100 in a future release** — callers that
     * rely on the implicit cap should pass an explicit `options.limit`
     * matching their expectation, or paginate via `options.offset`.
     */
    static async getStorageProgramsByOwner(
        owner: string,
        repository: Repository<GCRStorageProgram>,
        requesterAddress?: string,
        options?: { limit?: number; offset?: number },
    ): Promise<GCRStorageProgram[]> {
        const rawLimit = options?.limit ?? 200
        const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 200)
        const rawOffset = options?.offset ?? 0
        const offset = Math.max(0, Math.floor(rawOffset))

        // Owner fast-path: same owner index as before, no jsonb evaluation.
        if (requesterAddress === owner) {
            return repository.find({
                where: { owner, isDeleted: false },
                order: { createdAt: "DESC" },
                take: limit,
                skip: offset,
            })
        }

        const qb = repository
            .createQueryBuilder("sp")
            .where("sp.owner = :owner", { owner })
            .andWhere("sp.isDeleted = false")

        const acl = this.readReachablePredicate(requesterAddress)
        qb.andWhere(acl.sql, acl.params)

        return qb
            .orderBy("sp.createdAt", "DESC")
            .take(limit)
            .skip(offset)
            .getMany()
    }

    /**
     * Search storage programs by name (partial or exact match), ACL-filtered
     * for the requester at the SQL layer so LIMIT/OFFSET produce full pages.
     *
     * The previous implementation paginated first and ACL-filtered the
     * already-truncated result, which produced short pages and hid accessible
     * rows past the SQL window. Now the predicate is part of the WHERE clause
     * so the database returns exactly the requested page of *accessible*
     * rows.
     *
     * @param namePattern - The name or partial name to search for
     * @param repository - TypeORM repository for GCRStorageProgram
     * @param options - Search options (limit, offset, exactMatch, requesterAddress)
     * @returns Array of matching storage programs the requester can read
     */
    static async searchStorageProgramsByName(
        namePattern: string,
        repository: Repository<GCRStorageProgram>,
        options?: {
            limit?: number
            offset?: number
            exactMatch?: boolean
            requesterAddress?: string
        },
    ): Promise<GCRStorageProgram[]> {
        const limit = options?.limit ?? 50
        const offset = options?.offset ?? 0
        const exactMatch = options?.exactMatch ?? false

        const qb = repository.createQueryBuilder("sp")

        if (exactMatch) {
            qb.where("sp.programName = :name", { name: namePattern })
        } else {
            qb.where("sp.programName ILIKE :pattern", {
                pattern: `%${namePattern}%`,
            })
        }
        qb.andWhere("sp.isDeleted = false")

        const acl = this.readReachablePredicate(options?.requesterAddress)
        qb.andWhere(acl.sql, acl.params)

        return qb
            .orderBy("sp.createdAt", "DESC")
            .take(limit)
            .skip(offset)
            .getMany()
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
            if (
                requesterAddress &&
                acl.blacklisted?.includes(requesterAddress)
            ) {
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
                    if (!group || typeof group !== "object") continue
                    if (!Array.isArray(group.members) || !Array.isArray(group.permissions)) continue
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

    // =========================================================================
    // REVIEW: Granular Field Operations
    // =========================================================================
    //
    // Each operation builds the next data object and never changes the stored
    // one: the cached entity is shared by the simulate path and by the block's
    // later transactions, and stored values must not alias the payload of the
    // transaction that carried them.

    /**
     * The checks every granular operation shares, and the data it starts from.
     */
    private static granularTarget(
        edit: GCREditStorageProgram,
        program: GCRStorageProgram | null,
        operation: string,
    ):
        | { error: GCRResult }
        | {
              variables: GranularVariables
              program: GCRStorageProgram
              data: Record<string, unknown>
          } {
        const fail = (message: string) => ({
            error: { success: false, message } as GCRResult,
        })

        // The edit carries only the new value, so the old one cannot be put
        // back. Re-applying it forward would append twice or keep the write.
        // A failed transaction is undone from its row snapshot instead, and
        // the orphan rollback in sync only meets state an older binary wrote,
        // which never applied these edits and so recorded nothing to undo.
        if (edit.isRollback) {
            return fail(`${operation} cannot be rolled back`)
        }

        const variables = edit.context.data?.variables as
            | GranularVariables
            | undefined
        if (
            !variables ||
            typeof variables.field !== "string" ||
            variables.field === ""
        ) {
            return fail(`Field name is required for ${operation} operation`)
        }
        if (RESERVED_FIELD_NAMES.has(variables.field)) {
            return fail(`Field name ${variables.field} is reserved`)
        }

        if (!program) {
            return fail(`Storage program not found: ${edit.target}`)
        }
        if (program.isDeleted) {
            return fail(`Storage program has been deleted: ${edit.target}`)
        }
        if (program.encoding === "binary") {
            return fail(
                `${operation} operation not supported for binary encoding. Use WRITE_STORAGE instead.`,
            )
        }
        if (
            program.owner !== edit.context.sender &&
            !checkWritePermission(program.acl, edit.context.sender)
        ) {
            return fail("No permission to write to this storage program")
        }

        const data = program.data ?? {}
        if (typeof data !== "object" || Array.isArray(data)) {
            return fail(
                `${operation} needs the stored data to be a JSON object`,
            )
        }

        return { variables, program, data }
    }

    /**
     * The value a write stores, refused when it cannot be stored as written.
     */
    private static granularValue(
        variables: GranularVariables,
        operation: string,
    ): { error: GCRResult } | { value: unknown; fee: bigint } {
        const fail = (message: string) => ({
            error: { success: false, message } as GCRResult,
        })
        if (variables.value === undefined) {
            return fail(`Value is required for ${operation} operation`)
        }
        const footprint = granularWriteFootprint(variables)
        const depth = calculateJsonNestingDepth(footprint)
        if (depth > 64) {
            return fail(`JSON nesting depth ${depth} exceeds maximum 64 levels`)
        }
        return {
            value: structuredClone(variables.value),
            fee: granularWriteFee(variables),
        }
    }

    /**
     * Stores the next data with its size, fee and interaction record, or only
     * checks it when simulating.
     */
    private static commitGranular(
        edit: GCREditStorageProgram,
        program: GCRStorageProgram,
        operation: string,
        next: Record<string, unknown>,
        fee: bigint,
        simulate: boolean,
    ): GCRResult {
        const newSizeBytes = calculateDataSize(next, "json")
        if (newSizeBytes > STORAGE_PROGRAM_MAX_SIZE_BYTES) {
            return {
                success: false,
                message: `Data size ${newSizeBytes} bytes exceeds maximum ${STORAGE_PROGRAM_MAX_SIZE_BYTES} bytes (1MB)`,
            }
        }

        if (simulate) {
            log.debug(
                `[StorageProgram] Simulated ${operation}: ${edit.target}`,
            )
            return { success: true, message: `Simulated ${operation} successful` }
        }

        program.data = next
        program.sizeBytes = newSizeBytes
        program.lastModifiedByTx = edit.txhash
        program.interactionTxs = [
            ...(program.interactionTxs || []).slice(-(MAX_INTERACTION_TXS - 1)),
            edit.txhash,
        ]
        program.totalFeesPaid = program.totalFeesPaid + fee

        log.info(
            `[StorageProgram] ${operation}: ${edit.target} (size: ${newSizeBytes} bytes, fee: ${fee} DEM)`,
        )

        return {
            success: true,
            message: `${operation} applied to ${edit.target}`,
            storageProgram: program,
        }
    }

    /**
     * Handle SET_FIELD operation - set a single field value
     */
    private static async handleSetField(
        edit: GCREditStorageProgram,
        program: GCRStorageProgram | null,
        simulate: boolean,
    ): Promise<GCRResult> {
        const target = this.granularTarget(edit, program, "SET_FIELD")
        if ("error" in target) return target.error
        const written = this.granularValue(target.variables, "SET_FIELD")
        if ("error" in written) return written.error

        const next = { ...target.data, [target.variables.field]: written.value }
        return this.commitGranular(
            edit,
            target.program,
            "SET_FIELD",
            next,
            written.fee,
            simulate,
        )
    }

    /**
     * Handle SET_ITEM operation - set an item at a specific array index
     */
    private static async handleSetItem(
        edit: GCREditStorageProgram,
        program: GCRStorageProgram | null,
        simulate: boolean,
    ): Promise<GCRResult> {
        const target = this.granularTarget(edit, program, "SET_ITEM")
        if ("error" in target) return target.error
        const { variables, data } = target

        const item = granularItem(data, variables)
        if ("error" in item) return item.error
        const { items, index } = item
        const written = this.granularValue(variables, "SET_ITEM")
        if ("error" in written) return written.error

        const nextItems = items.slice()
        nextItems[index] = written.value
        return this.commitGranular(
            edit,
            target.program,
            "SET_ITEM",
            { ...data, [variables.field]: nextItems },
            written.fee,
            simulate,
        )
    }

    /**
     * Handle APPEND_ITEM operation - append an item to an array field,
     * creating the array when the field does not exist
     */
    private static async handleAppendItem(
        edit: GCREditStorageProgram,
        program: GCRStorageProgram | null,
        simulate: boolean,
    ): Promise<GCRResult> {
        const target = this.granularTarget(edit, program, "APPEND_ITEM")
        if ("error" in target) return target.error
        const { variables, data } = target

        // Only an absent field starts a new array: one holding null is a
        // value that is not an array.
        const items = Object.hasOwn(data, variables.field)
            ? data[variables.field]
            : []
        if (!Array.isArray(items)) {
            return {
                success: false,
                message: `Field ${variables.field} is not an array`,
            }
        }
        const written = this.granularValue(variables, "APPEND_ITEM")
        if ("error" in written) return written.error

        return this.commitGranular(
            edit,
            target.program,
            "APPEND_ITEM",
            { ...data, [variables.field]: [...items, written.value] },
            written.fee,
            simulate,
        )
    }

    /**
     * Handle DELETE_FIELD operation - delete a single field (no fee)
     */
    private static async handleDeleteField(
        edit: GCREditStorageProgram,
        program: GCRStorageProgram | null,
        simulate: boolean,
    ): Promise<GCRResult> {
        const target = this.granularTarget(edit, program, "DELETE_FIELD")
        if ("error" in target) return target.error
        const { variables, data } = target

        if (!Object.hasOwn(data, variables.field)) {
            return {
                success: false,
                message: `Field ${variables.field} does not exist`,
            }
        }

        const next = { ...data }
        delete next[variables.field]
        return this.commitGranular(
            edit,
            target.program,
            "DELETE_FIELD",
            next,
            0n,
            simulate,
        )
    }

    /**
     * Handle DELETE_ITEM operation - delete an item at a specific array
     * index (no fee)
     */
    private static async handleDeleteItem(
        edit: GCREditStorageProgram,
        program: GCRStorageProgram | null,
        simulate: boolean,
    ): Promise<GCRResult> {
        const target = this.granularTarget(edit, program, "DELETE_ITEM")
        if ("error" in target) return target.error
        const { variables, data } = target

        const item = granularItem(data, variables)
        if ("error" in item) return item.error
        const { items, index } = item

        return this.commitGranular(
            edit,
            target.program,
            "DELETE_ITEM",
            {
                ...data,
                [variables.field]: items.filter((_, i) => i !== index),
            },
            0n,
            simulate,
        )
    }
}

/**
 * Check if address has delete permission in ACL
 */
function checkDeletePermission(
    acl: {
        mode: string
        allowed?: string[]
        blacklisted?: string[]
        groups?: Record<string, { members: string[]; permissions: string[] }>
    },
    address: string,
): boolean {
    // Check blacklist first
    if (acl.blacklisted?.includes(address)) {
        return false
    }

    // Check groups
    if (acl.groups) {
        for (const group of Object.values(acl.groups)) {
            if (!group || typeof group !== "object") continue
            if (!Array.isArray(group.members) || !Array.isArray(group.permissions)) continue
            if (
                group.members.includes(address) &&
                group.permissions.includes("delete")
            ) {
                return true
            }
        }
    }

    return false
}

/**
 * Check if address has write permission in ACL (non-owner).
 * Note: Owner check is done separately in handleWrite before calling this.
 *
 * Per spec (04-acl.mdx):
 * - Owner mode: Only owner can write (this function returns false)
 * - Public mode: Only owner can write (this function returns false)
 * - Restricted mode: Owner or group with "write" permission
 */
function checkWritePermission(
    acl: {
        mode: string
        allowed?: string[]
        blacklisted?: string[]
        groups?: Record<string, { members: string[]; permissions: string[] }>
    },
    address: string,
): boolean {
    // Check blacklist first
    if (acl.blacklisted?.includes(address)) {
        return false
    }

    // Owner mode: only owner can write (handled by caller)
    if (acl.mode === "owner") {
        return false
    }

    // Public mode: only owner can write (handled by caller)
    if (acl.mode === "public") {
        return false
    }

    // Restricted mode: check groups for write permission
    if (acl.mode === "restricted" && acl.groups) {
        for (const group of Object.values(acl.groups)) {
            if (!group || typeof group !== "object") continue
            if (!Array.isArray(group.members) || !Array.isArray(group.permissions)) continue
            if (
                group.members.includes(address) &&
                group.permissions.includes("write")
            ) {
                return true
            }
        }
    }

    return false
}
