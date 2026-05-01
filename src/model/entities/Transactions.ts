import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm"

@Entity("transactions")
@Index("idx_transactions_hash", ["hash"])
@Index("idx_transactions_blockNumber", ["blockNumber"])
@Index("idx_transactions_from_ed25519_address", ["from_ed25519_address"])
@Index("idx_transactions_to", ["to"])
export class Transactions {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("integer", { name: "blockNumber" })
    blockNumber: number

    @Column("varchar", { name: "signature" })
    signature: string

    @Column("varchar", { name: "ed25519_signature", nullable: true })
    ed25519_signature: string

    @Column("varchar", { name: "status" })
    status: string

    @Column("varchar", { name: "hash", unique: true })
    hash: string

    @Column("json", { name: "content" })
    content: NonNullable<any>

    @Column("varchar", { name: "type" })
    type: TransactionContent["type"]

    @Column("varchar", { name: "from" })
    from: string

    @Column("varchar", { name: "from_ed25519_address", nullable: true })
    from_ed25519_address: string

    @Column("varchar", { name: "to" })
    to: string

    @Column("bigint", { name: "amount", nullable: true })
    amount: bigint

    @Column("bigint", { name: "nonce", nullable: true, default: 0 })
    nonce: number

    @Column("bigint", { name: "timestamp" })
    timestamp: number

    // REVIEW Widened from `integer` (32-bit) to `bigint` so OS-denominated
    // fees (post-migration) cannot be silently truncated. Pre-migration the
    // values still fit in 32 bits, so the migration is a pure widening with
    // no data conversion required. TypeORM returns bigint columns as JS
    // strings unless a transformer is supplied; callers around
    // toRawTransaction/fromRawTransaction (the only consumers) coerce via
    // BigInt() at the boundary.
    @Column("bigint", { name: "networkFee" })
    networkFee: bigint

    @Column("bigint", { name: "rpcFee" })
    rpcFee: bigint

    @Column("bigint", { name: "additionalFee" })
    additionalFee: bigint
}
