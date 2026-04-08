// REVIEW: GCR_Token entity for storing token data
import {
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
} from "typeorm"
import type {
    TokenMetadata,
    TokenState,
    TokenAccessControl,
    TokenScript,
} from "@/libs/blockchain/gcr/types/Token"

/**
 * GCR_Token stores fungible token data.
 * Each token has its own GCR entry with metadata, state, and ACL.
 *
 * Storage Model:
 * - Token data is stored in this table (primary source of truth)
 * - Holder pointers are stored in GCRExtended.tokens (lightweight references)
 */
@Entity("gcr_tokens")
@Index("idx_gcr_tokens_deployer", ["deployer"])
@Index("idx_gcr_tokens_ticker", ["ticker"])
export class GCRToken {
    // Token address (derived: sha256(deployer + nonce + hash(tokenObject)))
    @PrimaryColumn({ type: "text", name: "address" })
    address: string

    // Token metadata (immutable after creation)
    @Column({ type: "text", name: "name" })
    name: string

    @Column({ type: "text", name: "ticker" })
    ticker: string

    @Column({ type: "integer", name: "decimals" })
    decimals: number

    @Column({ type: "text", name: "deployer" })
    deployer: string

    @Column({ type: "integer", name: "deployerNonce" })
    deployerNonce: number

    @Column({ type: "bigint", name: "deployedAt" })
    deployedAt: number

    @Column({ type: "boolean", name: "hasScript", default: false })
    hasScript: boolean

    // Token state (mutable)
    @Column({ type: "text", name: "totalSupply" })
    totalSupply: string

    @Column({ type: "jsonb", name: "balances", default: () => "'{}'" })
    balances: Record<string, string> // address -> balance

    @Column({ type: "jsonb", name: "allowances", default: () => "'{}'" })
    allowances: Record<string, Record<string, string>> // owner -> spender -> amount

    @Column({ type: "jsonb", name: "customState", default: () => "'{}'" })
    customState: Record<string, unknown>

    // Access control
    @Column({ type: "text", name: "owner" })
    owner: string

    @Column({ type: "boolean", name: "paused", default: false })
    paused: boolean

    @Column({ type: "jsonb", name: "aclEntries", default: () => "'[]'" })
    aclEntries: Array<{
        address: string
        permissions: string[]
        grantedAt: number
        grantedBy: string
    }>

    // Optional script (stored as JSONB for flexibility)
    @Column({ type: "jsonb", name: "script", nullable: true })
    script?: TokenScript


    // Script version tracking
    // REVIEW: Phase 4.1 - Script upgrade mechanism version tracking
    @Column({ type: "integer", name: "scriptVersion", default: 0 })
    scriptVersion: number

    @Column({ type: "bigint", name: "lastScriptUpdate", nullable: true })
    lastScriptUpdate: number | null

    // Tracking
    @Column({ type: "text", name: "deployTxHash" })
    deployTxHash: string

    @CreateDateColumn({ type: "timestamp", name: "createdAt" })
    createdAt: Date

    @UpdateDateColumn({ type: "timestamp", name: "updatedAt" })
    updatedAt: Date

    /**
     * Converts entity to TokenMetadata format
     */
    toMetadata(): TokenMetadata {
        return {
            name: this.name,
            ticker: this.ticker,
            decimals: this.decimals,
            address: this.address,
            deployer: this.deployer,
            deployerNonce: this.deployerNonce,
            deployedAt: this.deployedAt,
            hasScript: this.hasScript,
        }
    }

    /**
     * Converts entity to TokenState format
     */
    toState(): TokenState {
        return {
            totalSupply: this.totalSupply,
            balances: this.balances,
            allowances: this.allowances,
            customState: this.customState,
        }
    }

    /**
     * Converts entity to TokenAccessControl format
     */
    toAccessControl(): TokenAccessControl {
        return {
            owner: this.owner,
            paused: this.paused,
            entries: this.aclEntries.map((e) => ({
                address: e.address,
                permissions: e.permissions as any,
                grantedAt: e.grantedAt,
                grantedBy: e.grantedBy,
            })),
        }
    }
}
