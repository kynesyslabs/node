import Block from "@/libs/blockchain/block"
import { Transaction } from "@kynesyslabs/demosdk/types"
import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"

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
    transactions: Transaction[] | null

    @Column("text", { name: "proposedBlock", nullable: true })
    proposedBlock: Block | null
}
