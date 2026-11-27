import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm"

/** A `tlsn_request` token row under `tlsnVerified`: unused, used by a store, or used by an identity link. */
export type TlsnTokenStatus = "pending" | "stored" | "linked"

/**
 * One row per TLSNotary attestation token.
 *
 * Before `tlsnVerified`, rows were written only by a shipped `tlsnotary`
 * store edit and carry no status. Under the fork a `tlsn_request` writes a
 * `pending` row keyed by its own tx hash; the `tlsn_store` that names it
 * fills in the proof and sets it `stored`, or a TLSN identity link whose
 * bind names it sets it `linked` with the link's attestation id. Every column the chain writes
 * under the fork is derived from the block (heights, tx hashes, the verified
 * presentation), so the row is the same on every node.
 */
@Entity("gcr_tlsnotary")
@Index("idx_gcr_tlsnotary_owner", ["owner"])
@Index("idx_gcr_tlsnotary_domain", ["domain"])
@Index("idx_gcr_tlsnotary_txhash", ["txhash"])
@Index("idx_gcr_tlsnotary_attestation", ["attestationId"], { unique: true })
export class GCRTLSNotary {
    @PrimaryColumn({ type: "text", name: "tokenId" })
    tokenId: string

    @Column({ type: "text", name: "owner" })
    owner: string

    @Column({ type: "text", name: "domain" })
    domain: string

    /** Null while a request is pending. */
    @Column({ type: "text", name: "proof", nullable: true })
    proof: string | null

    @Column({ type: "text", name: "storageType", nullable: true })
    storageType: "onchain" | "ipfs" | null

    /** The tx that last wrote the row: the request, then its store. */
    @Column({ type: "text", name: "txhash" })
    txhash: string

    @Column({
        type: "bigint",
        name: "proofTimestamp",
        transformer: {
            to: (v: string) => v,
            from: (v: string | number) => String(v),
        },
    })
    proofTimestamp: string

    /** Null on rows written before `tlsnVerified`. */
    @Column({ type: "text", name: "status", nullable: true })
    status: TlsnTokenStatus | null

    @Column({ type: "integer", name: "requestHeight", nullable: true })
    requestHeight: number | null

    /** Last block height at which the request can still be used. */
    @Column({ type: "integer", name: "expiresAtHeight", nullable: true })
    expiresAtHeight: number | null

    /** The notary-signed attestation id: unique, so a proof is stored once. */
    @Column({ type: "text", name: "attestationId", nullable: true })
    attestationId: string | null

    @Column({ type: "integer", name: "storedAtHeight", nullable: true })
    storedAtHeight: number | null

    // Stamped by each node's own clock: kept for operators, never hashed
    // under tlsnVerified.
    @CreateDateColumn({ type: "timestamp", name: "createdAt" })
    createdAt: Date
}
