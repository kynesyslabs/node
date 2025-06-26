import { Entity, PrimaryColumn, Column, Index } from "typeorm"
import { L2PSTransaction } from "@kynesyslabs/demosdk/types"

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
export class L2PSMempoolTx {
    /**
     * Primary key: Hash of the encrypted L2PS transaction wrapper
     * @example "0xa1b2c3d4..."
     */
    @Index()
    @PrimaryColumn("text") 
    hash: string

    /**
     * L2PS network identifier
     * @example "network_1", "private_subnet_alpha"
     */
    @Index()
    @Index(["l2ps_uid", "timestamp"])
    @Index(["l2ps_uid", "status"])
    @Index(["l2ps_uid", "block_number"])
    @Column("text") 
    l2ps_uid: string

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
     */
    @Index()
    @Column("bigint") 
    timestamp: bigint

    /**
     * Target block number for inclusion (follows main mempool pattern)
     */
    @Index()
    @Column("integer") 
    block_number: number
}   