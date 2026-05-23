import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
} from "typeorm"

/**
 * Records which transactions have been assigned to which GCR account.
 *
 * Replaces the `assignedTxs` jsonb array that used to live on `gcr_main`.
 * Moving this out eliminates the TOAST write-amplification that came from
 * appending to a growing jsonb column on every block.
 */
@Entity("gcr_assigned_txs")
@Index("idx_gcr_assigned_txs_pubkey", ["pubkey", "blockNumber"])
export class GCRAssignedTx {
    @PrimaryColumn({ type: "text", name: "pubkey" })
    pubkey: string

    @PrimaryColumn({ type: "text", name: "tx_hash" })
    txHash: string

    @Column({ type: "integer", name: "block_number", default: 0 })
    blockNumber: number

    @CreateDateColumn({ type: "timestamptz", name: "assigned_at" })
    assignedAt: Date
}
