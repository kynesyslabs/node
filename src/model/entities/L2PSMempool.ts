import { Entity, PrimaryColumn, Column, Index } from "typeorm"
import type { L2PSTransaction } from "@kynesyslabs/demosdk/types"

/**
 * L2PS Mempool Entity
 * 
 * Stores L2PS (Layer 2 Privacy Subnets) transactions separately from the main mempool.
 * This entity maintains encrypted L2PS transactions for participating nodes while
 * preserving privacy by not storing decrypted transaction content.
 * 
 * @entity l2ps_mempool
 */
@Entity("l2ps_mempool")
@Index("IDX_L2PS_UID_TIMESTAMP", ["l2ps_uid", "timestamp"])
@Index("IDX_L2PS_UID_STATUS", ["l2ps_uid", "status"])
@Index("IDX_L2PS_UID_BLOCK", ["l2ps_uid", "block_number"])
@Index("IDX_L2PS_UID_SEQUENCE", ["l2ps_uid", "sequence_number"])
export class L2PSMempoolTx {
    /**
     * Primary key: Hash of the encrypted L2PS transaction wrapper
     * @example "0xa1b2c3d4..."
     * REVIEW: PR Fix #14 - Removed redundant @Index() as primary keys are automatically indexed
     */
    @PrimaryColumn("text")
    hash: string

    /**
     * L2PS network identifier
     * @example "network_1", "private_subnet_alpha"
     */
    @Column("text") 
    l2ps_uid: string

    /**
     * Sequence number within the L2PS network for ordering
     * Auto-incremented per l2ps_uid to ensure deterministic transaction order
     * @example 1, 2, 3... or timestamp-based sequence like 1697049600, 1697049601...
     */
    @Column("bigint", { default: "0" })
    sequence_number: string

    /**
     * Hash of the original transaction before encryption
     * Used for integrity verification and duplicate detection
     * @example "0xe5f6g7h8..."
     */
    @Index()
    @Column("text") 
    original_hash: string

    /**
     * Full encrypted L2PS transaction object
     * Stored as JSONB for efficient querying during hash generation
     */
    @Column("jsonb")
    encrypted_tx: L2PSTransaction

    /**
     * Processing status of the transaction
     * @example "pending", "processed", "failed"
     */
    @Column("text") 
    status: string

    /**
     * Unix timestamp in milliseconds when transaction was processed
     * REVIEW: PR Fix - TypeORM returns SQL bigint as string type to prevent JavaScript precision loss
     * Using string type for TypeScript to match TypeORM runtime behavior
     */
    @Index()
    @Column("bigint")
    timestamp: string

    /**
     * Target block number for inclusion (follows main mempool pattern)
     */
    @Index()
    @Column("integer") 
    block_number: number
}   