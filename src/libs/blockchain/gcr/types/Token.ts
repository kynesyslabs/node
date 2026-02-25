/**
 * Token Types for Demos Network Node
 *
 * REVIEW: Phase 1.4 - Token GCREdit Types (node-sut5)
 *
 * This file re-exports all token types from the token/ subdirectory and augmentations.
 *
 * Storage Model:
 * - Token data stored in token's GCR account
 * - Holder pointers stored in holder's GCRExtended.tokens array
 *
 * @license CC BY-NC-ND 4.0
 * @copyright 2023-2024 KyneSys Labs
 * @see https://www.kynesys.xyz/
 */

// REVIEW: Re-export all types from the token subdirectory
// Note: Direct file imports to avoid Bun bundler cycle detection issues

// From TokenTypes
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
} from "./token/TokenTypes"

// From GCREditToken
export {
    type GCREditTokenOperation,
    type GCREditTokenBase,
    type GCREditTokenCreate,
    type GCREditTokenTransfer,
    type GCREditTokenMint,
    type GCREditTokenBurn,
    type GCREditTokenPause,
    type GCREditTokenUnpause,
    type GCREditTokenUpdateACL,
    type GCREditTokenGrantPermission,
    type GCREditTokenRevokePermission,
    type GCREditTokenUpgradeScript,
    type GCREditTokenTransferOwnership,
    type GCREditToken,
    isGCREditToken,
    type ExtendedGCREdit,
} from "./token/GCREditToken"

// From TokenPermissions
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
} from "./token/TokenPermissions"

// REVIEW: Re-export token types from augmentations (for backward compatibility)
export type {
    TokenGCROperation,
    TokenCreateData,
    TokenTransferData,
    TokenMintData,
    TokenBurnData,
    TokenACLUpdateData,
    TokenPauseData,
    TokenScriptUpgradeData,
    TokenApproveData,
    TokenTransferFromData,
    TokenScriptExecuteData,
} from "@/types/token-augmentations"

// SECTION: Node-specific Token Types

/**
 * Token GCR account structure as stored in the database
 * This is the complete structure for a token's GCR entry
 */
export interface TokenGCRAccount {
    /** Token address (derived from deployer + nonce + hash) */
    address: string
    /** Token metadata */
    metadata: {
        name: string
        ticker: string
        decimals: number
        deployer: string
        deployerNonce: number
        deployedAt: number
        hasScript: boolean
    }
    /** Token state */
    state: {
        totalSupply: string
        balances: Record<string, string>
        allowances: Record<string, Record<string, string>>
        customState: Record<string, unknown>
    }
    /** Access control */
    accessControl: {
        owner: string
        paused: boolean
        entries: Array<{
            address: string
            permissions: string[]
            grantedAt: number
            grantedBy: string
        }>
    }
    /** Optional script */
    script?: {
        version: number
        code: string
        methods: Array<{
            name: string
            params: Array<{ name: string; type: string }>
            returns?: string
            mutates: boolean
        }>
        hooks: string[]
        codeHash: string
        upgradedAt: number
    }
}

/**
 * Token validation result
 */
export interface TokenValidationResult {
    valid: boolean
    errors: string[]
    warnings: string[]
}

/**
 * Token operation context for script execution
 */
export interface TokenOperationContext {
    /** Caller address */
    caller: string
    /** Token address */
    tokenAddress: string
    /** Operation being performed */
    operation: string
    /** Operation arguments */
    args: unknown[]
    /** Block height at execution */
    blockHeight: number
    /** Previous block hash (for deterministic randomness) */
    prevBlockHash: string
    /** Transaction timestamp */
    txTimestamp: number
    /** Transaction hash */
    txHash: string
}

/**
 * Token holder entry stored in user's GCRExtended.tokens
 * This is a lightweight pointer to the token's GCR account
 */
export interface TokenHolderEntry {
    /** Token address */
    tokenAddress: string
    /** Cached ticker for quick display */
    ticker: string
    /** Cached name for quick display */
    name: string
    /** Cached decimals for formatting */
    decimals: number
    /** When this token was first acquired */
    firstAcquiredAt: number
    /** Last update timestamp */
    lastUpdatedAt: number
}

/**
 * Token event types for logging/indexing
 */
export type TokenEventType =
    | "TokenCreated"
    | "TokenTransfer"
    | "TokenMint"
    | "TokenBurn"
    | "TokenApproval"
    | "TokenPaused"
    | "TokenUnpaused"
    | "TokenACLUpdated"
    | "TokenScriptUpgraded"
    | "TokenScriptExecuted"

/**
 * Token event structure for logging
 */
export interface TokenEvent {
    type: TokenEventType
    tokenAddress: string
    txHash: string
    blockHeight: number
    timestamp: number
    data: Record<string, unknown>
}

// SECTION: Utility Functions

/**
 * Check if an address has a specific permission on a token
 */
export function hasTokenPermission(
    accessControl: TokenGCRAccount["accessControl"],
    address: string,
    permission: string,
): boolean {
    // Owner has all permissions
    if (accessControl.owner === address) {
        return true
    }

    // Check ACL entries
    const entry = accessControl.entries.find(e => e.address === address)
    if (!entry) {
        return false
    }

    return entry.permissions.includes(permission)
}

/**
 * Check if a token is paused
 */
export function isTokenPaused(accessControl: TokenGCRAccount["accessControl"]): boolean {
    return accessControl.paused
}

/**
 * Get token balance for an address
 */
export function getTokenBalance(
    state: TokenGCRAccount["state"],
    address: string,
): bigint {
    const balance = state.balances[address]
    return balance ? BigInt(balance) : BigInt(0)
}

/**
 * Get token allowance for a spender
 */
export function getTokenAllowance(
    state: TokenGCRAccount["state"],
    owner: string,
    spender: string,
): bigint {
    const ownerAllowances = state.allowances[owner]
    if (!ownerAllowances) {
        return BigInt(0)
    }
    const allowance = ownerAllowances[spender]
    return allowance ? BigInt(allowance) : BigInt(0)
}

// SECTION: Legacy Token Class (deprecated)

/**
 * @deprecated Use TokenGCRAccount interface instead
 * This class is maintained for backward compatibility only
 */
export default class Token {
    address: string
    name: string
    ticker: string
    decimals: number
}
