import Block from "@/libs/blockchain/block"
import {
    ISignature,
    Transaction,
    TransactionContent,
} from "@kynesyslabs/demosdk/types"
import {
    BeforeInsert,
    Column,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from "typeorm"

@Entity("mempool")
export class Mempool {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("integer", { name: "number" })
    number: number

    @Column("integer", { name: "current" })
    current: number

    @Column("bigint", { name: "timestamp" })
    timestamp: number

    @Column("jsonb", { name: "transactions", nullable: true })
    transactions: string | null

    @Column("text", { name: "proposedBlock", nullable: true })
    proposedBlock: string | null
}

@Entity("mempooltx")
export class MempoolTx implements Transaction {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Index()
    @Column("text", { name: "hash", unique: true })
    hash: string

    @Column("bigint", { name: "timestamp" })
    timestamp: bigint

    @Column("json", { name: "content" })
    content: TransactionContent

    @Column("json", { name: "signature" })
    signature: ISignature

    @Column("text", { name: "status" })
    status: string

    @Column("integer", { name: "blockNumber" })
    blockNumber: number

    @Column("jsonb", { name: "extra", nullable: true })
    extra: Record<string, any> | null

    @Column("integer", { name: "nonce" })
    nonce: number
}
