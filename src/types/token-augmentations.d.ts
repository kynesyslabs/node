/**
 * Token GCREdit Type Augmentations
 *
 * REVIEW: Phase 1.4 - Token GCREdit Types (node-sut5)
 *
 * Extends the SDK's GCREdit types with token-specific operations:
 * - createToken: Create a new token (stores token data in GCR)
 * - transferToken: Transfer tokens between addresses
 * - mintToken: Mint new tokens (if authorized)
 * - burnToken: Burn tokens (if authorized)
 * - updateTokenACL: Modify token access control list
 * - pauseToken: Pause token operations
 * - unpauseToken: Resume token operations
 * - upgradeTokenScript: Update token script code
 *
 * Note: Token types are defined locally until published in the SDK.
 * Once SDK 2.12.0+ is available with token types, these can be replaced
 * with re-exports from @kynesyslabs/demosdk/types.
 */

// SECTION: Token Permission Types (local definitions pending SDK export)

/**
 * Permission flags for token access control
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
 * Hook types that can trigger script execution
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
 * Script method definition
 */
export interface TokenScriptMethod {
    name: string
    params: Array<{ name: string; type: string }>
    returns?: string
    mutates: boolean
}

/**
 * State mutation returned by scripts
 */
export interface StateMutation {
    type: "setBalance" | "addBalance" | "subBalance" | "setCustomState" | "setAllowance"
    address?: string
    spender?: string
    value: string | number | Record<string, unknown>
    key?: string
}

// SECTION: Token Metadata Types

/**
 * Immutable token metadata set at creation time
 */
export interface TokenMetadata {
    name: string
    ticker: string
    decimals: number
    address: string
    deployer: string
    deployerNonce: number
    deployedAt: number
    hasScript: boolean
}

/**
 * Token balances mapping: address -> balance
 */
export type TokenBalances = Record<string, string>

/**
 * Token allowances mapping: owner -> spender -> amount
 */
export type TokenAllowances = Record<string, Record<string, string>>

/**
 * Custom state for scripted tokens
 */
export type TokenCustomState = Record<string, unknown>

/**
 * Complete token state
 */
export interface TokenState {
    totalSupply: string
    balances: TokenBalances
    allowances: TokenAllowances
    customState: TokenCustomState
}

/**
 * Token script definition
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
 * Access Control List entry
 */
export interface TokenACLEntry {
    address: string
    permissions: TokenPermission[]
    grantedAt: number
    grantedBy: string
}

/**
 * Token Access Control structure
 */
export interface TokenAccessControl {
    owner: string
    paused: boolean
    entries: TokenACLEntry[]
}

// SECTION: Token GCREdit Operation Types

/**
 * Token operation types for GCREdit
 */
export type TokenGCROperation =
    | "createToken"
    | "transferToken"
    | "mintToken"
    | "burnToken"
    | "updateTokenACL"
    | "pauseToken"
    | "unpauseToken"
    | "upgradeTokenScript"
    | "approveToken"
    | "transferFromToken"
    | "executeScript"

// SECTION: Token Operation Data Structures

/**
 * Data for createToken operation
 */
export interface TokenCreateData {
    /** Token metadata (name, ticker, decimals, etc.) */
    metadata: TokenMetadata
    /** Initial token state (supply, balances) */
    initialState: TokenState
    /** Initial access control configuration */
    accessControl: TokenAccessControl
    /** Optional script for advanced tokens */
    script?: TokenScript
}

/**
 * Data for transferToken operation
 */
export interface TokenTransferData {
    /** Token address */
    tokenAddress: string
    /** Sender address */
    from: string
    /** Recipient address */
    to: string
    /** Amount to transfer (string for bigint serialization) */
    amount: string
    /** Script mutations if hooks were triggered */
    mutations?: StateMutation[]
}

/**
 * Data for mintToken operation
 */
export interface TokenMintData {
    /** Token address */
    tokenAddress: string
    /** Recipient address */
    to: string
    /** Amount to mint (string for bigint serialization) */
    amount: string
    /** Script mutations if hooks were triggered */
    mutations?: StateMutation[]
}

/**
 * Data for burnToken operation
 */
export interface TokenBurnData {
    /** Token address */
    tokenAddress: string
    /** Address to burn from */
    from: string
    /** Amount to burn (string for bigint serialization) */
    amount: string
    /** Script mutations if hooks were triggered */
    mutations?: StateMutation[]
}

/**
 * Data for updateTokenACL operation
 */
export interface TokenACLUpdateData {
    /** Token address */
    tokenAddress: string
    /** Action to perform */
    action: "grant" | "revoke"
    /** Target address for ACL change */
    targetAddress: string
    /** Permissions to grant/revoke */
    permissions: string[]
    /** Who granted/revoked (for audit trail) */
    grantedBy: string
    /** Timestamp of the change */
    timestamp: number
}

/**
 * Data for pauseToken / unpauseToken operations
 */
export interface TokenPauseData {
    /** Token address */
    tokenAddress: string
    /** Address that triggered the pause/unpause */
    triggeredBy: string
    /** Timestamp of the action */
    timestamp: number
}

/**
 * Data for upgradeTokenScript operation
 */
export interface TokenScriptUpgradeData {
    /** Token address */
    tokenAddress: string
    /** New script code */
    newCode: string
    /** New script version */
    newVersion: number
    /** New method definitions */
    newMethods: TokenScriptMethod[]
    /** New hooks */
    newHooks: TokenHookType[]
    /** Hash of the new code for verification */
    newCodeHash: string
    /** Address that performed the upgrade */
    upgradedBy: string
    /** Timestamp of the upgrade */
    timestamp: number
}

/**
 * Result returned from script upgrade operation
 * REVIEW: Phase 4.1 - Script upgrade result
 */
export interface TokenUpgradeResult {
    /** Whether upgrade was successful */
    success: boolean
    /** New version number after upgrade */
    newVersion: number
    /** Previous version number before upgrade */
    previousVersion: number
    /** Timestamp when upgrade occurred */
    upgradedAt: number
    /** Hash of the new script code */
    newCodeHash: string
}

/**
 * Data for approveToken operation (ERC20-like allowance)
 */
export interface TokenApproveData {
    /** Token address */
    tokenAddress: string
    /** Owner address (who is approving) */
    owner: string
    /** Spender address (who can spend) */
    spender: string
    /** Approved amount (string for bigint serialization) */
    amount: string
}

/**
 * Data for transferFromToken operation (ERC20-like transferFrom)
 */
export interface TokenTransferFromData {
    /** Token address */
    tokenAddress: string
    /** Spender address (who is executing the transfer) */
    spender: string
    /** From address (owner of the tokens) */
    from: string
    /** To address (recipient) */
    to: string
    /** Amount to transfer (string for bigint serialization) */
    amount: string
    /** Script mutations if hooks were triggered */
    mutations?: StateMutation[]
}

/**
 * Data for executeScript operation (custom script methods)
 */
export interface TokenScriptExecuteData {
    /** Token address */
    tokenAddress: string
    /** Method name to execute */
    method: string
    /** Method arguments */
    args: unknown[]
    /** Caller address */
    caller: string
    /** Resulting state mutations */
    mutations: StateMutation[]
    /** Return value from script (if any) */
    returnValue?: unknown
    /** Execution complexity for fee calculation */
    complexity: number
}

// SECTION: GCREdit Token Interface

/**
 * GCREdit for token operations
 * This follows the same pattern as other GCREdit types (GCREditBalance, GCREditTLSNotary, etc.)
 */
export interface GCREditToken {
    type: "token"
    operation: TokenGCROperation
    /** Account that initiated the operation (transaction sender) */
    account: string
    /** Token address (for all operations except createToken, where it's the new address) */
    tokenAddress: string
    /** Operation-specific data */
    data:
        | TokenCreateData
        | TokenTransferData
        | TokenMintData
        | TokenBurnData
        | TokenACLUpdateData
        | TokenPauseData
        | TokenScriptUpgradeData
        | TokenApproveData
        | TokenTransferFromData
        | TokenScriptExecuteData
    /** Transaction hash */
    txhash: string
    /** Whether this is a rollback operation */
    isRollback: boolean
}
