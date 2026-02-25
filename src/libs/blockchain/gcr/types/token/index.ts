// REVIEW: Token types index for GCR Token operations

// Export TokenTypes (TokenPermission is re-exported from TokenTypes which sources it from TokenPermissions)
export {
    type TokenPermission,
    type TokenACLEntry,
    type TokenAccessControl,
    type TokenMetadata,
    type TokenBalances,
    type TokenAllowances,
    type TokenCustomState,
    type TokenState,
    type TokenHookType,
    type TokenScriptMethod,
    type TokenScript,
    type TokenData,
    type TokenHolderReference,
    type StateMutation,
    hasPermission,
} from "./TokenTypes"

export * from "./GCREditToken"

// REVIEW: Phase 4.2 - Permission constants and utilities
// Export permission utilities and constants (but not TokenPermission type to avoid duplicate)
export {
    TokenPermissionValue,
    ALL_PERMISSIONS,
    PERMISSION_DESCRIPTIONS,
    MINTER_PERMISSIONS,
    ADMIN_PERMISSIONS,
    OPERATOR_PERMISSIONS,
    FULL_PERMISSIONS,
    isValidPermission,
    validatePermissions,
    filterValidPermissions,
    includesPermission,
    hasAllPermissions,
    hasAnyPermission,
    mergePermissions,
    removePermissions,
    permissionDifference,
    permissionIntersection,
} from "./TokenPermissions"
