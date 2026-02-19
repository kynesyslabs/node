import { Transaction } from "@kynesyslabs/demosdk/types"
import type { ISignature } from "@kynesyslabs/demosdk/types"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import {
    Column,
    Entity,
    Index,
    PrimaryColumn,
} from "typeorm"

@Entity("mempooltx")
@Index("idx_mempooltx_hash", ["hash"])
@Index("idx_mempooltx_reference_block", ["reference_block"])
export class MempoolTx implements Transaction {
    @Index()
    @PrimaryColumn("text", { name: "hash", unique: true })
    hash: string

    @Column("bigint", { name: "timestamp" })
    timestamp: bigint

    @Column("json", { name: "content" })
    content: TransactionContent

    @Column("json", { name: "signature" })
    signature: ISignature

    @Column("varchar", { name: "ed25519_signature", nullable: true })
    ed25519_signature: string

    @Column("text", { name: "status" })
    status: string

    @Column("integer", { name: "blockNumber" })
    blockNumber: number

    @Column("jsonb", { name: "extra", nullable: true })
    extra: Record<string, any> | null

    @Column("bigint", { name: "nonce", nullable: true, default: 0 })
    nonce: number

    @Column("integer", { name: "reference_block" })
    reference_block: number
}
