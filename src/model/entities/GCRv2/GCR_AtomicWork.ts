import { Column, Entity, Index, PrimaryColumn } from "typeorm"

/**
 * One row per Work that ran: the attempt that won and, once committed in
 * the same transition, its receipt. Losing attempts never reach a block
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

    @Column({ type: "text", name: "effectsRoot", nullable: true })
    effectsRoot: string | null

    @Column({ type: "text", name: "inputHash", nullable: true })
    inputHash: string | null

    @Column({ type: "text", name: "outputHash", nullable: true })
    outputHash: string | null
}
