import type { StorageProgramPayload } from "@kynesyslabs/demosdk/storage"
import { validateStorageProgramAccess } from "@/libs/blockchain/validators/validateStorageProgramAccess"
import { validateStorageProgramData, getDataSize } from "@/libs/blockchain/validators/validateStorageProgramSize"
import type { GCREdit } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"

// REVIEW: Storage Program transaction handler

interface StorageProgramResponse {
    success: boolean
    message: string
    gcrEdits?: GCREdit[]
}

const ACCESS_CONTROL_VALUES = ["private", "public", "restricted", "deployer-only"] as const
type AccessControlMode = (typeof ACCESS_CONTROL_VALUES)[number]
type ValidationContext = "CREATE" | "UPDATE_ACCESS_CONTROL"

const ACCESS_CONTROL_MODES = new Set<AccessControlMode>(ACCESS_CONTROL_VALUES)
const ALLOWED_ADDRESS_PATTERN = /^[a-f0-9]{64}$/i

function normalizeAccessControl(
    accessControl: unknown,
    context: ValidationContext,
): { success: true; mode: AccessControlMode } | { success: false; message: string } {
    if (typeof accessControl !== "string" || !ACCESS_CONTROL_MODES.has(accessControl as AccessControlMode)) {
        return {
            success: false,
            message: `${context} requires valid accessControl mode`,
        }
    }

    return {
        success: true,
        mode: accessControl as AccessControlMode,
    }
}

function validateAllowedAddresses(
    accessControl: AccessControlMode,
    allowedAddresses: unknown,
): { success: true; addresses: string[] } | { success: false; message: string } {
    if (allowedAddresses === undefined) {
        if (accessControl === "restricted") {
            return {
                success: false,
                message: "Restricted mode requires allowedAddresses array",
            }
        }

        return {
            success: true,
            addresses: [],
        }
    }

    if (!Array.isArray(allowedAddresses)) {
        return {
            success: false,
            message: "allowedAddresses must be an array",
        }
    }

    for (const address of allowedAddresses) {
        if (typeof address !== "string") {
            return {
                success: false,
                message: "allowedAddresses must contain only string values",
            }
        }

        if (!ALLOWED_ADDRESS_PATTERN.test(address)) {
            return {
                success: false,
                message: `Invalid address format in allowedAddresses: ${address}`,
            }
        }
    }

    if (accessControl === "restricted" && allowedAddresses.length === 0) {
        return {
            success: false,
            message: "Restricted mode requires at least one address in allowedAddresses",
        }
    }

    return {
        success: true,
        addresses: allowedAddresses as string[],
    }
}

/**
 * Handle Storage Program transactions
 *
 * Supports operations:
 * - CREATE_STORAGE_PROGRAM: Initialize new storage with access control
 * - WRITE_STORAGE: Write/update key-value data
 * - READ_STORAGE: Query validation (actual reads use RPC)
 * - UPDATE_ACCESS_CONTROL: Modify permissions (deployer only)
 * - DELETE_STORAGE_PROGRAM: Remove entire program (deployer only)
 *
 * @param payload - Storage Program operation payload
 * @param sender - Transaction sender address
 * @param txHash - Transaction hash
 * @returns Response with success status, message, and GCR edits
 */
export default async function handleStorageProgramTransaction(
    payload: StorageProgramPayload,
    sender: string,
    txHash: string,
): Promise<StorageProgramResponse> {
    const { operation, storageAddress } = payload

    log.info(`[StorageProgram] Operation: ${operation}, Address: ${storageAddress}, Sender: ${sender}`)

    try {
        switch (operation) {
            case "CREATE_STORAGE_PROGRAM":
                return await handleCreate(payload, sender, txHash)

            case "WRITE_STORAGE":
                return await handleWrite(payload, sender, txHash)

            case "READ_STORAGE":
                // READ is a query operation, not a transaction
                return {
                    success: false,
                    message: "READ_STORAGE is a query operation, use RPC endpoints",
                }

            case "UPDATE_ACCESS_CONTROL":
                return await handleUpdateAccessControl(payload, sender, txHash)

            case "DELETE_STORAGE_PROGRAM":
                return await handleDelete(payload, sender, txHash)

            default:
                return {
                    success: false,
                    message: `Unknown storage program operation: ${operation}`,
                }
        }
    } catch (error) {
        log.error(`[StorageProgram] Error handling ${operation}: ${error instanceof Error ? error.message : String(error)}`)
        return {
            success: false,
            message: `Error: ${error instanceof Error ? error.message : String(error)}`,
        }
    }
}

/**
 * Handle CREATE_STORAGE_PROGRAM operation
 */
async function handleCreate(
    payload: StorageProgramPayload,
    sender: string,
    txHash: string,
): Promise<StorageProgramResponse> {
    const { storageAddress, programName, data, accessControl, allowedAddresses, salt } = payload

    // Validate required fields
    if (!programName) {
        return {
            success: false,
            message: "CREATE requires programName",
        }
    }

    // Validate programName content
    if (typeof programName !== "string" || programName.length === 0) {
        return {
            success: false,
            message: "programName must be a non-empty string",
        }
    }

    if (programName.length > 128) {
        return {
            success: false,
            message: "programName exceeds maximum length of 128 characters",
        }
    }

    // Validate programName format (alphanumeric, underscores, hyphens, dots)
    if (!/^[a-zA-Z0-9_.-]+$/.test(programName)) {
        return {
            success: false,
            message: "programName contains invalid characters (allowed: a-z, A-Z, 0-9, _, -, .)",
        }
    }

    if (!data) {
        return {
            success: false,
            message: "CREATE requires initial data",
        }
    }

    const accessControlValidation = normalizeAccessControl(accessControl, "CREATE")
    if (accessControlValidation.success === false) {
        return {
            success: false,
            message: accessControlValidation.message,
        }
    }

    const allowedAddressesValidation = validateAllowedAddresses(
        accessControlValidation.mode,
        allowedAddresses,
    )
    if (allowedAddressesValidation.success === false) {
        return {
            success: false,
            message: allowedAddressesValidation.message,
        }
    }

    // CREATE is permissionless - any address can create a storage program
    // The sender becomes the deployer and is recorded in metadata

    // Validate data constraints
    const dataValidation = validateStorageProgramData(data)
    if (!dataValidation.success) {
        return {
            success: false,
            message: dataValidation.error || "Data validation failed",
        }
    }

    // Create GCR edit for storage program creation
    const now = Date.now()
    const dataSize = getDataSize(data)

    const gcrEdit: GCREdit = {
        type: "storageProgram",
        target: storageAddress,
        isRollback: false,
        txhash: txHash,
        context: {
            operation: "CREATE",
            sender,
            data: {
                variables: data,
                metadata: {
                    programName,
                    deployer: sender,
                    accessControl: accessControlValidation.mode,
                    allowedAddresses: allowedAddressesValidation.addresses,
                    created: now,
                    lastModified: now,
                    size: dataSize,
                },
            },
        },
    }

    log.info(`[StorageProgram] CREATE successful: ${storageAddress} (${dataSize} bytes)`)

    return {
        success: true,
        message: `Storage program created: ${storageAddress}`,
        gcrEdits: [gcrEdit],
    }
}

/**
 * Handle WRITE_STORAGE operation
 */
async function handleWrite(
    payload: StorageProgramPayload,
    sender: string,
    txHash: string,
): Promise<StorageProgramResponse> {
    const { storageAddress, data } = payload

    if (!data) {
        return {
            success: false,
            message: "WRITE requires data",
        }
    }

    // NOTE: Access validation will be done by HandleGCR when applying the edit
    // because it needs to read the current storage data from the database

    // Validate data constraints
    const dataValidation = validateStorageProgramData(data)
    if (!dataValidation.success) {
        return {
            success: false,
            message: dataValidation.error || "Data validation failed",
        }
    }

    // Create GCR edit for write operation
    // NOTE: metadata.size here represents the delta (incoming data only)
    // The actual merged size will be calculated and updated in HandleGCR.applyStorageProgramEdit()
    const gcrEdit: GCREdit = {
        type: "storageProgram",
        target: storageAddress,
        isRollback: false,
        txhash: txHash,
        context: {
            operation: "WRITE",
            data: {
                variables: data,
                metadata: {
                    lastModified: Date.now(),
                    size: getDataSize(data), // Delta size only - will be recalculated after merge
                },
            },
            sender, // Include sender for access control check in HandleGCR
        },
    }

    log.info(`[StorageProgram] WRITE queued: ${storageAddress}`)

    return {
        success: true,
        message: `Write operation queued for: ${storageAddress}`,
        gcrEdits: [gcrEdit],
    }
}

/**
 * Handle UPDATE_ACCESS_CONTROL operation
 */
async function handleUpdateAccessControl(
    payload: StorageProgramPayload,
    sender: string,
    txHash: string,
): Promise<StorageProgramResponse> {
    const { storageAddress, accessControl, allowedAddresses } = payload

    const accessControlValidation = normalizeAccessControl(accessControl, "UPDATE_ACCESS_CONTROL")
    if (accessControlValidation.success === false) {
        return {
            success: false,
            message: accessControlValidation.message,
        }
    }

    const allowedAddressesValidation = validateAllowedAddresses(
        accessControlValidation.mode,
        allowedAddresses,
    )
    if (allowedAddressesValidation.success === false) {
        return {
            success: false,
            message: allowedAddressesValidation.message,
        }
    }

    // NOTE: Access validation (deployer-only) will be done by HandleGCR

    // Create GCR edit for access control update
    const gcrEdit: GCREdit = {
        type: "storageProgram",
        target: storageAddress,
        isRollback: false,
        txhash: txHash,
        context: {
            operation: "UPDATE_ACCESS_CONTROL",
            data: {
                variables: {}, // No variable changes in access control update
                metadata: {
                    accessControl: accessControlValidation.mode,
                    allowedAddresses: allowedAddressesValidation.addresses,
                    lastModified: Date.now(),
                },
            },
            sender,
        },
    }

    log.info(`[StorageProgram] ACCESS_CONTROL update queued: ${storageAddress}`)

    return {
        success: true,
        message: `Access control update queued for: ${storageAddress}`,
        gcrEdits: [gcrEdit],
    }
}

/**
 * Handle DELETE_STORAGE_PROGRAM operation
 */
async function handleDelete(
    payload: StorageProgramPayload,
    sender: string,
    txHash: string,
): Promise<StorageProgramResponse> {
    const { storageAddress } = payload

    // NOTE: Access validation (deployer-only) will be done by HandleGCR

    // Create GCR edit for deletion
    const gcrEdit: GCREdit = {
        type: "storageProgram",
        target: storageAddress,
        isRollback: false,
        txhash: txHash,
        context: {
            operation: "DELETE",
            sender,
        },
    }

    log.info(`[StorageProgram] DELETE queued: ${storageAddress}`)

    return {
        success: true,
        message: `Delete operation queued for: ${storageAddress}`,
        gcrEdits: [gcrEdit],
    }
}
