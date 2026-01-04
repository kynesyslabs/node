import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
} from "typeorm"

// REVIEW: TLSNotary proof storage entity for on-chain attestation data
/**
 * GCR_TLSNotary stores TLSNotary attestation proofs.
 * Each proof is linked to a token and domain, stored via the tlsn_store native operation.
 */
@Entity("gcr_tlsnotary")
@Index("idx_gcr_tlsnotary_owner", ["owner"])
@Index("idx_gcr_tlsnotary_domain", ["domain"])
@Index("idx_gcr_tlsnotary_txhash", ["txhash"])
export class GCRTLSNotary {
    @PrimaryColumn({ type: "text", name: "tokenId" })
    tokenId: string

    @Column({ type: "text", name: "owner" })
    owner: string

    @Column({ type: "text", name: "domain" })
    domain: string

    @Column({ type: "text", name: "proof" })
    proof: string

    @Column({ type: "text", name: "storageType" })
    storageType: "onchain" | "ipfs"

    @Column({ type: "text", name: "txhash" })
    txhash: string

    @Column({ type: "bigint", name: "proofTimestamp" })
    proofTimestamp: number

    @CreateDateColumn({ type: "timestamp", name: "createdAt" })
    createdAt: Date
}
