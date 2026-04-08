/**
 * Token Permissions for Demos Network
 *
 * REVIEW: Phase 4.2 - Access Control List Management
 *
 * This file defines the permission system for token access control.
 * Permissions are granular capabilities that can be granted to addresses,
 * allowing them to perform specific operations on tokens.
 *
 * Permission Hierarchy:
 * - Owner has ALL permissions implicitly (never needs ACL entries)
 * - Other addresses need explicit ACL entries to gain permissions
 * - Empty ACL = only owner can perform protected operations
 *
 * @license CC BY-NC-ND 4.0
 * @copyright 2023-2024 KyneSys Labs
 * @see https://www.kynesys.xyz/
 */

// SECTION: Permission Constants

/**
 * Token permission types as a const enum for performance.
 * Using const enum allows TypeScript to inline values at compile time.
 */
export const enum TokenPermissionValue {
    CAN_MINT = "canMint",
    CAN_BURN = "canBurn",
    CAN_UPGRADE = "canUpgrade",
    CAN_PAUSE = "canPause",
    CAN_TRANSFER_OWNERSHIP = "canTransferOwnership",
    CAN_MODIFY_ACL = "canModifyACL",
    CAN_EXECUTE_SCRIPT = "canExecuteScript",
}

/**
 * Permission type as string union for type checking.
 * This is the primary type used in interfaces and APIs.
 */
export type TokenPermission =
    | "canMint"
    | "canBurn"
    | "canUpgrade"
    | "canPause"
    | "canTransferOwnership"
    | "canModifyACL"
    | "canExecuteScript"

/**
 * Array of all valid permission strings.
 * Useful for validation and iteration.
 */
export const ALL_PERMISSIONS: readonly TokenPermission[] = [
    "canMint",
    "canBurn",
    "canUpgrade",
    "canPause",
    "canTransferOwnership",
    "canModifyACL",
    "canExecuteScript",
] as const

/**
 * Permission descriptions for documentation and UI.
 */
export const PERMISSION_DESCRIPTIONS: Record<TokenPermission, string> = {
    canMint: "Allows minting new tokens, increasing total supply",
    canBurn: "Allows burning tokens from any address (not just own)",
    canUpgrade: "Allows upgrading the token script code",
    canPause: "Allows pausing/unpausing token operations",
    canTransferOwnership: "Allows transferring token ownership to another address",
    canModifyACL: "Allows granting/revoking permissions to other addresses",
    canExecuteScript: "Allows calling custom script methods",
}

// SECTION: Permission Groups (for convenience)

/**
 * Permissions typically granted to a minter role.
 */
export const MINTER_PERMISSIONS: readonly TokenPermission[] = ["canMint"] as const

/**
 * Permissions typically granted to an admin role.
 */
export const ADMIN_PERMISSIONS: readonly TokenPermission[] = [
    "canMint",
    "canBurn",
    "canPause",
    "canModifyACL",
] as const

/**
 * Permissions typically granted to an operator role.
 */
export const OPERATOR_PERMISSIONS: readonly TokenPermission[] = [
    "canPause",
    "canExecuteScript",
] as const

/**
 * All permissions (effectively makes an address co-owner).
 * Use with caution - this grants full control except ownership transfer.
 */
export const FULL_PERMISSIONS: readonly TokenPermission[] = ALL_PERMISSIONS

// SECTION: Validation Utilities

/**
 * Validates if a string is a valid permission.
 *
 * @param permission - String to validate
 * @returns True if the string is a valid TokenPermission
 */
export function isValidPermission(permission: string): permission is TokenPermission {
    return ALL_PERMISSIONS.includes(permission as TokenPermission)
}

/**
 * Validates an array of permissions.
 *
 * @param permissions - Array of strings to validate
 * @returns Object with validity status and any invalid permissions found
 */
export function validatePermissions(permissions: string[]): {
    valid: boolean
    invalid: string[]
} {
    const invalid = permissions.filter((p) => !isValidPermission(p))
    return {
        valid: invalid.length === 0,
        invalid,
    }
}

/**
 * Filters an array to only include valid permissions.
 *
 * @param permissions - Array of strings that may contain invalid permissions
 * @returns Array containing only valid TokenPermission values
 */
export function filterValidPermissions(permissions: string[]): TokenPermission[] {
    return permissions.filter(isValidPermission)
}

// SECTION: Permission Checking

/**
 * Checks if a permission array includes a specific permission.
 *
 * @param permissions - Array of permissions to check
 * @param permission - Permission to look for
 * @returns True if the permission is present
 */
export function includesPermission(
    permissions: TokenPermission[],
    permission: TokenPermission,
): boolean {
    return permissions.includes(permission)
}

/**
 * Checks if a permission array includes all of the specified permissions.
 *
 * @param permissions - Array of permissions to check
 * @param required - Array of required permissions
 * @returns True if all required permissions are present
 */
export function hasAllPermissions(
    permissions: TokenPermission[],
    required: TokenPermission[],
): boolean {
    return required.every((p) => permissions.includes(p))
}

/**
 * Checks if a permission array includes any of the specified permissions.
 *
 * @param permissions - Array of permissions to check
 * @param candidates - Array of candidate permissions
 * @returns True if at least one candidate permission is present
 */
export function hasAnyPermission(
    permissions: TokenPermission[],
    candidates: TokenPermission[],
): boolean {
    return candidates.some((p) => permissions.includes(p))
}

// SECTION: Permission Set Operations

/**
 * Merges two permission arrays, removing duplicates.
 *
 * @param existing - Current permissions
 * @param additions - Permissions to add
 * @returns Merged array with no duplicates
 */
export function mergePermissions(
    existing: TokenPermission[],
    additions: TokenPermission[],
): TokenPermission[] {
    const set = new Set([...existing, ...additions])
    return Array.from(set)
}

/**
 * Removes permissions from an array.
 *
 * @param existing - Current permissions
 * @param removals - Permissions to remove
 * @returns Array with specified permissions removed
 */
export function removePermissions(
    existing: TokenPermission[],
    removals: TokenPermission[],
): TokenPermission[] {
    return existing.filter((p) => !removals.includes(p))
}

/**
 * Gets the difference between two permission arrays.
 *
 * @param a - First array
 * @param b - Second array
 * @returns Permissions in a but not in b
 */
export function permissionDifference(
    a: TokenPermission[],
    b: TokenPermission[],
): TokenPermission[] {
    return a.filter((p) => !b.includes(p))
}

/**
 * Gets the intersection of two permission arrays.
 *
 * @param a - First array
 * @param b - Second array
 * @returns Permissions present in both arrays
 */
export function permissionIntersection(
    a: TokenPermission[],
    b: TokenPermission[],
): TokenPermission[] {
    return a.filter((p) => b.includes(p))
}
