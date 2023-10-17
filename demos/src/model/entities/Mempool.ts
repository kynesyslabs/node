import { Column, Entity } from "typeorm"

@Entity("mempool")
export class Mempool {
    @Column("integer", { name: "number", nullable: true })
    number: number | null

    @Column("integer", { name: "current", nullable: true })
    current: number | null

    @Column("text", { name: "transactions", nullable: true })
    transactions: string | null

    @Column("text", { name: "proposedBlock", nullable: true })
    proposedBlock: string | null
}
