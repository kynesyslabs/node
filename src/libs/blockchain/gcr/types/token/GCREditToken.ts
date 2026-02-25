// REVIEW: Token GCREdit types for Demos Network token operations
// These types are defined locally until SDK publishes them (Phase 1.4)
// FIXME: Once SDK 2.12.0 is released with token types, import from @kynesyslabs/demosdk/types

import type {
    TokenData,
    TokenScript,
    TokenHolderReference,
} from "./TokenTypes"
import type { TokenPermission } from "./TokenPermissions"
import { GCREdit as SDKGCREdit } from "@kynesyslabs/demosdk/types"

/**
 * Token operation types for GCREdit
 */
export type GCREditTokenOperation =
    | "create"
    | "transfer"
    | "mint"
    | "burn"
    | "pause"
    | "unpause"
    | "updateACL"
    | "grantPermission"
    | "revokePermission"
    | "upgradeScript"
    | "transferOwnership"
    | "custom" // Phase 5.2: Custom script method execution

/**
 * Base interface for all Token GCREdit operations
 */
export interface GCREditTokenBase {
    type: "token"
    operation: GCREditTokenOperation
    account: string // The account performing the operation
    tokenAddress: string // The token being operated on
    txhash: string
    isRollback: boolean
}

/**
 * GCREdit for creating a new token
 */
export interface GCREditTokenCreate extends Omit<GCREditTokenBase, "tokenAddress"> {
    operation: "create"
    data: {
        // Full token data to store
        tokenData: TokenData
        // Token address (derived from deployer + nonce + hash)
        tokenAddress: string
    }
}

/**
 * GCREdit for transferring tokens
 */
export interface GCREditTokenTransfer extends GCREditTokenBase {
    operation: "transfer"
    data: {
        from: string
        to: string
        amount: string
    }
}

/**
 * GCREdit for minting tokens
 */
export interface GCREditTokenMint extends GCREditTokenBase {
    operation: "mint"
    data: {
        to: string
        amount: string
    }
}

/**
 * GCREdit for burning tokens
 */
export interface GCREditTokenBurn extends GCREditTokenBase {
    operation: "burn"
    data: {
        from: string
        amount: string
    }
}

/**
 * GCREdit for pausing a token
 */
export interface GCREditTokenPause extends GCREditTokenBase {
    operation: "pause"
    data: Record<string, never> // Empty data for pause
}

/**
 * GCREdit for unpausing a token
 */
export interface GCREditTokenUnpause extends GCREditTokenBase {
    operation: "unpause"
    data: Record<string, never> // Empty data for unpause
}

/**
 * GCREdit for updating token ACL (generic form)
 */
export interface GCREditTokenUpdateACL extends GCREditTokenBase {
    operation: "updateACL"
    data: {
        action: "grant" | "revoke"
        targetAddress: string
        permissions: TokenPermission[]
    }
}

// REVIEW: Phase 4.2 - Dedicated Grant/Revoke Permission GCREdit types

/**
 * GCREdit for granting permissions to an address.
 * This is a specialized form of updateACL for explicit typing.
 */
export interface GCREditTokenGrantPermission extends GCREditTokenBase {
    operation: "grantPermission"
    data: {
        /** Address to grant permissions to */
        grantee: string
        /** Permissions to grant */
        permissions: TokenPermission[]
    }
}

/**
 * GCREdit for revoking permissions from an address.
 * This is a specialized form of updateACL for explicit typing.
 */
export interface GCREditTokenRevokePermission extends GCREditTokenBase {
    operation: "revokePermission"
    data: {
        /** Address to revoke permissions from */
        grantee: string
        /** Permissions to revoke */
        permissions: TokenPermission[]
    }
}

/**
 * GCREdit for upgrading token script
 */
export interface GCREditTokenUpgradeScript extends GCREditTokenBase {
    operation: "upgradeScript"
    data: {
        /** New script definition */
        newScript: TokenScript
        /** Optional reason for the upgrade (for audit trail) */
        upgradeReason?: string
        /** Previous script version (for rollback support) */
        previousVersion?: number
    }
}

/**
 * GCREdit for transferring token ownership
 */
export interface GCREditTokenTransferOwnership extends GCREditTokenBase {
    operation: "transferOwnership"
    data: {
        newOwner: string
    }
}

// REVIEW: Phase 5.2 - Custom script method execution

/**
 * GCREdit for executing a custom script method.
 * This enables user-defined write operations beyond native operations.
 * Examples: stake(), claimRewards(), vote(), etc.
 */
export interface GCREditTokenCustom extends GCREditTokenBase {
    operation: "custom"
    data: {
        /** Method name to execute */
        method: string
        /** Method parameters */
        params: unknown[]
        /** Optional: State mutations returned by the script execution */
        mutations?: Array<{
            type: "setBalance" | "setAllowance" | "setMetadata" | "setStorage"
            target?: string
            key?: string
            value: unknown
        }>
    }
}

/**
 * Union type of all Token GCREdit operations
 */
export type GCREditToken =
    | GCREditTokenCreate
    | GCREditTokenTransfer
    | GCREditTokenMint
    | GCREditTokenBurn
    | GCREditTokenPause
    | GCREditTokenUnpause
    | GCREditTokenUpdateACL
    | GCREditTokenGrantPermission
    | GCREditTokenRevokePermission
    | GCREditTokenUpgradeScript
    | GCREditTokenTransferOwnership
    | GCREditTokenCustom

/**
 * Type guard to check if a GCREdit is a Token operation
 */
export function isGCREditToken(edit: { type: string }): edit is GCREditToken {
    return edit.type === "token"
}

/**
 * Extended GCREdit type that includes token operations
 * FIXME: Remove this once SDK includes token type in GCREdit union
 */
export type ExtendedGCREdit = SDKGCREdit | GCREditToken
