import type {
    StorageProgramPayload,
    StorageProgramAccessControl,
} from "@kynesyslabs/demosdk/storage"
import type { GCRMain } from "@/model/entities/GCRv2/GCR_Main"

// REVIEW: Access control validator for Storage Programs

/**
 * Validate if a user has access to perform an operation on a Storage Program
 *
 * Access control rules:
 * - private: Only deployer can read and write
 * - public: Anyone can read, only deployer can write
 * - restricted: Only addresses in allowedAddresses can read/write
 * - deployer-only: Only deployer has all permissions (same as private but explicit)
 *
 * @param operation - The storage operation being performed
 * @param requestingAddress - Address requesting the operation
 * @param storageData - Current storage program data from GCR
 * @returns Object with success boolean and optional error message
 */
export function validateStorageProgramAccess(
    operation: string,
    requestingAddress: string,
    storageData: GCRMain["data"],
): { success: boolean; error?: string } {
    const metadata = storageData.metadata

    // If no metadata exists, program doesn't exist
    if (!metadata) {
        return {
            success: false,
            error: "Storage program does not exist",
        }
    }

    const { deployer, accessControl, allowedAddresses } = metadata
    const isDeployer = requestingAddress === deployer

    // Admin operations (UPDATE_ACCESS_CONTROL, DELETE) require deployer
    if (
        operation === "UPDATE_ACCESS_CONTROL" ||
        operation === "DELETE_STORAGE_PROGRAM"
    ) {
        if (!isDeployer) {
            return {
                success: false,
                error: "Only deployer can perform admin operations",
            }
        }
        return { success: true }
    }

    // Handle access control based on mode
    switch (accessControl) {
        case "private":
        case "deployer-only":
            // Only deployer can read and write
            if (!isDeployer) {
                return {
                    success: false,
                    error: `Access denied: ${accessControl} mode allows deployer only`,
                }
            }
            return { success: true }

        case "public":
            // Anyone can read (READ_STORAGE)
            if (operation === "READ_STORAGE") {
                return { success: true }
            }
            // Only deployer can write
            if (operation === "WRITE_STORAGE") {
                if (!isDeployer) {
                    return {
                        success: false,
                        error: "Public mode: only deployer can write",
                    }
                }
            }
            return { success: true }

        case "restricted":
            // Check if address is in allowlist
            if (!allowedAddresses || !Array.isArray(allowedAddresses)) {
                return {
                    success: false,
                    error: "Restricted mode requires allowedAddresses list",
                }
            }

            if (!isDeployer && !allowedAddresses.includes(requestingAddress)) {
                return {
                    success: false,
                    error: "Access denied: address not in allowlist",
                }
            }
            return { success: true }

        default:
            return {
                success: false,
                error: `Unknown access control mode: ${accessControl}`,
            }
    }
}

/**
 * Validate access for CREATE operation (special case - no existing storage)
 *
 * @param requestingAddress - Address creating the storage program
 * @param payload - The creation payload
 * @returns Object with success boolean and optional error message
 */
export function validateCreateAccess(
    requestingAddress: string,
    payload: StorageProgramPayload,
): { success: boolean; error?: string } {
    // CREATE is permissionless - any address can create a storage program
    // The sender becomes the deployer and is recorded in metadata for subsequent access control
    return { success: true }
}
