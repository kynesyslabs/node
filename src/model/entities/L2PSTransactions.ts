/**
 * L2PS Transactions Entity
 * 
 * Stores individual L2PS transactions with reference to L1 batch.
 * L2PS transactions are batched together and submitted as ONE L1 transaction.
 * This table tracks each L2 tx with its L1 batch reference.
 * 
 * @module L2PSTransactions
 */

import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    CreateDateColumn,
} from "typeorm"
import { bigintNumericTransformer } from "./transformers"

/**
 * L2PS Transaction Entity
 *
 * The durable record of what executed in a subnet:
 * - L2PS network scope (l2ps_uid)
 * - Routing and settlement metadata (parties, amount, batch, status)
 * - The transaction payload, as ciphertext
 *
 * The payload is kept encrypted at rest and decrypted only to answer an
 * authenticated read from one of the parties. Routing metadata stays in the
 * clear because the account history query selects on it, and because the
 * balance movements it describes are already settled on L1 through the
 * batch's GCR edits — encrypting it here would cost the feature without
 * buying privacy. The message body is not in that position, and it is what
 * this table used to leave lying around in `content`.
 */
@Entity("l2ps_transactions")
@Index("IDX_L2PS_TX_UID", ["l2ps_uid"])
@Index("IDX_L2PS_TX_HASH", ["hash"])
@Index("IDX_L2PS_TX_FROM", ["from_address"])
@Index("IDX_L2PS_TX_TO", ["to_address"])
@Index("IDX_L2PS_TX_L1_BATCH", ["l1_batch_hash"])
@Index("IDX_L2PS_TX_UID_FROM", ["l2ps_uid", "from_address"])
@Index("IDX_L2PS_TX_UID_TO", ["l2ps_uid", "to_address"])
@Index("IDX_L2PS_TX_BLOCK", ["l1_block_number"])
@Index("IDX_L2PS_TX_UID_TIMESTAMP", ["l2ps_uid", "timestamp"])
export class L2PSTransaction {
    /**
     * Auto-generated primary key
     */
    @PrimaryGeneratedColumn()
    id: number

    /**
     * L2PS network UID this transaction belongs to
     */
    @Column("text")
    l2ps_uid: string

    /**
     * Original transaction hash (before encryption)
     */
    @Column("text", { unique: true })
    hash: string

    /**
     * Encrypted transaction hash (as stored in L2PS mempool)
     */
    @Column("text", { nullable: true })
    encrypted_hash: string

    /**
     * L1 batch transaction hash
     * Multiple L2 transactions share the same L1 batch hash
     */
    @Column("text", { nullable: true })
    l1_batch_hash: string

    /**
     * L1 block number where the batch was included
     */
    @Column("integer", { nullable: true })
    l1_block_number: number

    /**
     * Position of this tx within the L1 batch (for ordering)
     */
    @Column("integer", { default: 0 })
    batch_index: number

    /**
     * Transaction type (native, send, demoswork, etc.)
     */
    @Column("text")
    type: string

    /**
     * Sender address
     */
    @Column("text")
    from_address: string

    /**
     * Recipient address
     */
    @Column("text")
    to_address: string

    /**
     * Transaction amount. Widened from PG `bigint` (int8, max ~9.22 × 10^18)
     * to `numeric(38, 0)` for the same reason `transactions.amount` was
     * widened in the iter-5 fork bump: post-fork OS values exceed int8
     * on any meaningful supply (10 % of a 10^18 DEM founder wallet is
     * 10^26 OS). Application-level type stays `bigint` via the shared
     * transformer.
     */
    @Column({
        type: "numeric",
        precision: 38,
        scale: 0,
        default: "0",
        transformer: bigintNumericTransformer,
    })
    amount: bigint

    /**
     * Transaction nonce (for replay protection within L2PS)
     */
    @Column("bigint", { default: 0 })
    nonce: bigint

    /**
     * L2 transaction timestamp
     */
    @Column("bigint")
    timestamp: bigint

    /**
     * Transaction status
     * - pending: in L2PS mempool
     * - batched: included in L1 batch, waiting for L1 confirmation
     * - confirmed: L1 batch confirmed
     * - failed: execution failed
     */
    @Column("text", { default: "pending" })
    status: "pending" | "batched" | "confirmed" | "failed"

    /**
     * The encrypted transaction envelope, exactly as the subnet submitted it.
     *
     * This is what makes the history durable: peers sync from it and an
     * account read decrypts it on the fly, so nothing depends on the
     * aggregation queue, which is swept minutes after confirmation.
     */
    @Column("jsonb", { nullable: true })
    encrypted_payload: Record<string, any> | null

    /**
     * Decrypted transaction content, only when `l2ps.historyStorePlaintext`
     * is on. Null otherwise — and null on every row written by a node that
     * left it off, so readers fall back to decrypting `encrypted_payload`.
     */
    @Column("jsonb", { nullable: true })
    content: Record<string, any> | null

    /**
     * Execution result/error message
     */
    @Column("text", { nullable: true })
    execution_message: string

    /**
     * When transaction was added to the database
     */
    @CreateDateColumn()
    created_at: Date
}
