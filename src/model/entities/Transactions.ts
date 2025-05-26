import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"

@Entity("transactions")
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
    type: string

    @Column("varchar", { name: "from" })
    from: string

    @Column("varchar", { name: "ed25519_address" })
    ed25519_address: string

    @Column("varchar", { name: "to" })
    to: string

    @Column("integer", { name: "amount" })
    amount: number

    @Column("integer", { name: "nonce" })
    nonce: number

    @Column("bigint", { name: "timestamp" })
    timestamp: number

    @Column("integer", { name: "networkFee" })
    networkFee: number

    @Column("integer", { name: "rpcFee" })
    rpcFee: number

    @Column("integer", { name: "additionalFee" })
    additionalFee: number
}
