// REVIEW: Token types for Demos Network - local copy until SDK publishes
// FIXME: Once SDK 2.12.0 is released with token types, remove this file and import from @kynesyslabs/demosdk/types

// Import and re-export TokenPermission from TokenPermissions.ts (source of truth for permission type)
export type { TokenPermission } from "./TokenPermissions"
import type { TokenPermission } from "./TokenPermissions"

/**
 * Access Control List entry for a single address.
 */
export interface TokenACLEntry {
    address: string
    permissions: TokenPermission[]
    grantedAt: number // Unix timestamp
    grantedBy: string // Address that granted permissions
}

/**
 * Token Access Control structure.
 * Owner has all permissions by default.
 */
export interface TokenAccessControl {
    owner: string
    paused: boolean
    entries: TokenACLEntry[]
}

/**
 * Immutable token metadata set at creation time.
 */
export interface TokenMetadata {
    name: string
    ticker: string
    decimals: number
    address: string
    deployer: string
    deployerNonce: number
    deployedAt: number // Unix timestamp (block timestamp at deployment)
    hasScript: boolean
}

/**
 * Token balances mapping: address -> balance
 */
export type TokenBalances = Record<string, string> // string for bigint serialization

/**
 * Token allowances mapping: owner -> spender -> amount
 */
export type TokenAllowances = Record<string, Record<string, string>>

/**
 * Custom state for scripted tokens.
 */
export type TokenCustomState = Record<string, unknown>

/**
 * Complete token state.
 */
export interface TokenState {
    totalSupply: string // string for bigint serialization
    balances: TokenBalances
    allowances: TokenAllowances
    customState: TokenCustomState
}

/**
 * Hook types that can trigger script execution.
 */
export type TokenHookType =
    | "beforeTransfer"
    | "afterTransfer"
    | "beforeMint"
    | "afterMint"
    | "beforeBurn"
    | "afterBurn"
    | "onApprove"

/**
 * Script method definition.
 */
export interface TokenScriptMethod {
    name: string
    params: Array<{ name: string; type: string }>
    returns?: string
    mutates: boolean
}

/**
 * Token script definition.
 */
export interface TokenScript {
    version: number
    code: string
    methods: TokenScriptMethod[]
    hooks: TokenHookType[]
    codeHash: string
    upgradedAt: number
}

/**
 * Complete token data as stored in GCR.
 */
export interface TokenData {
    metadata: TokenMetadata
    state: TokenState
    accessControl: TokenAccessControl
    script?: TokenScript
}

/**
 * Lightweight token reference stored in holder's GCRExtended.tokens
 */
export interface TokenHolderReference {
    tokenAddress: string
    ticker: string
    name: string
    decimals: number
}

/**
 * State mutation returned by scripts.
 */
export interface StateMutation {
    type: "setBalance" | "addBalance" | "subBalance" | "setCustomState" | "setAllowance"
    address?: string
    spender?: string
    value: string | number | Record<string, unknown>
    key?: string
}

/**
 * Checks if an address has a specific permission.
 */
export function hasPermission(
    accessControl: TokenAccessControl,
    address: string,
    permission: TokenPermission,
): boolean {
    // Owner has all permissions
    if (accessControl.owner === address) {
        return true
    }

    // Check ACL entries
    const entry = accessControl.entries.find((e) => e.address === address)
    if (!entry) {
        return false
    }

    return entry.permissions.includes(permission)
}
