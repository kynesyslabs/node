import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"

@Entity("mempool")
export class Mempool {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("integer", { name: "number" })
    number: number

    @Column("integer", { name: "current" })
    current: number

    @Column("integer", { name: "timestamp" })
    timestamp: number

    @Column("text", { name: "transactions", nullable: true })
    transactions: string | null

    @Column("text", { name: "proposedBlock", nullable: true })
    proposedBlock: string | null
}
