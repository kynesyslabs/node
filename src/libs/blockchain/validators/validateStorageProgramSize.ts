// REVIEW: Size validator for Storage Programs

/**
 * Storage Program size limits
 */
export const STORAGE_LIMITS = {
    MAX_SIZE_BYTES: 128 * 1024, // 128KB total storage per program
    MAX_NESTING_DEPTH: 64, // Maximum nesting depth for objects
    MAX_KEY_LENGTH: 256, // Maximum key name length in characters
}

/**
 * Calculate the size of data in bytes
 *
 * @param data - The data object to measure
 * @returns Size in bytes
 */
export function getDataSize(data: Record<string, any>): number {
    const jsonString = JSON.stringify(data)
    return new TextEncoder().encode(jsonString).length
}

/**
 * Validate if data size is within the 128KB limit
 *
 * @param data - The data to validate
 * @returns Object with success boolean and optional error message
 */
export function validateSize(data: Record<string, any>): {
    success: boolean
    error?: string
    size?: number
} {
    const size = getDataSize(data)

    if (size > STORAGE_LIMITS.MAX_SIZE_BYTES) {
        return {
            success: false,
            error: `Data size ${size} bytes exceeds limit of ${STORAGE_LIMITS.MAX_SIZE_BYTES} bytes (128KB)`,
            size,
        }
    }

    return { success: true, size }
}

/**
 * Validate nesting depth of data structure
 *
 * @param data - The data to validate
 * @param maxDepth - Maximum allowed depth (default: 64)
 * @returns Object with success boolean and optional error message
 */
export function validateNestingDepth(
    data: any,
    maxDepth: number = STORAGE_LIMITS.MAX_NESTING_DEPTH,
): { success: boolean; error?: string; depth?: number } {
    const seen = new WeakSet() // Circular reference detection

    const getDepth = (obj: any, currentDepth = 1): number => {
        if (typeof obj !== "object" || obj === null) {
            return currentDepth
        }

        // Detect circular references
        if (seen.has(obj)) {
            return currentDepth
        }
        seen.add(obj)

        const depths = Object.values(obj).map(value =>
            getDepth(value, currentDepth + 1),
        )

        return Math.max(...depths, currentDepth)
    }

    const depth = getDepth(data)

    if (depth > maxDepth) {
        return {
            success: false,
            error: `Nesting depth ${depth} exceeds limit of ${maxDepth}`,
            depth,
        }
    }

    return { success: true, depth }
}

/**
 * Validate key lengths in data object
 *
 * @param data - The data object to validate
 * @param maxKeyLength - Maximum allowed key length (default: 256)
 * @returns Object with success boolean and optional error message
 */
export function validateKeyLengths(
    data: Record<string, any>,
    maxKeyLength: number = STORAGE_LIMITS.MAX_KEY_LENGTH,
): { success: boolean; error?: string; invalidKey?: string } {
    const checkKeys = (obj: any, path = ""): { success: boolean; error?: string; invalidKey?: string } => {
        if (typeof obj !== "object" || obj === null) {
            return { success: true }
        }

        for (const key of Object.keys(obj)) {
            if (key.length > maxKeyLength) {
                return {
                    success: false,
                    error: `Key length ${key.length} exceeds limit of ${maxKeyLength}`,
                    invalidKey: path ? `${path}.${key}` : key,
                }
            }

            // Recursively check nested objects
            const result = checkKeys(obj[key], path ? `${path}.${key}` : key)
            if (!result.success) {
                return result
            }
        }

        return { success: true }
    }

    return checkKeys(data)
}

/**
 * Validate all Storage Program constraints
 *
 * @param data - The data to validate
 * @returns Object with success boolean and optional error message
 */
export function validateStorageProgramData(data: Record<string, any>): {
    success: boolean
    error?: string
} {
    // Validate size
    const sizeCheck = validateSize(data)
    if (!sizeCheck.success) {
        return sizeCheck
    }

    // Validate nesting depth
    const depthCheck = validateNestingDepth(data)
    if (!depthCheck.success) {
        return depthCheck
    }

    // Validate key lengths
    const keyCheck = validateKeyLengths(data)
    if (!keyCheck.success) {
        return keyCheck
    }

    return { success: true }
}
