import { Column, Entity, Index, PrimaryColumn } from "typeorm"

/**
 * One row per Work that ran: the attempt that won and the receipt the node
 * built for it in the same transition. Losing attempts never reach a block
 * (their whole transaction is refused), so no other attempt is stored.
 */
@Entity("gcr_atomic_works")
@Index("idx_gcr_atomic_works_txhash", ["txHash"])
export class GCRAtomicWork {
    @PrimaryColumn({ type: "text", name: "workId" })
    workId: string

    @Column({ type: "text", name: "winnerAttemptId" })
    winnerAttemptId: string

    @Column({ type: "text", name: "canonicalBytesHash" })
    canonicalBytesHash: string

    @Column({ type: "text", name: "attemptClass" })
    attemptClass: "normal" | "replacement"

    @Column({ type: "text", name: "replacementFor", nullable: true })
    replacementFor: string | null

    @Column({ type: "text", name: "txHash" })
    txHash: string

    @Column({ type: "text", name: "receiptCommitment", nullable: true })
    receiptCommitment: string | null

    @Column({ type: "text", name: "operationReceiptRoot", nullable: true })
    operationReceiptRoot: string | null

    /** The receipt the node built, exactly as committed to. */
    @Column({ type: "jsonb", name: "receipt", nullable: true })
    receipt: Record<string, unknown> | null
}
