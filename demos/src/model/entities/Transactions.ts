import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"

@Entity("transactions")
export class Transactions {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("json", { name: "content" })
    content: NonNullable<unknown>

    @Column("varchar", { name: "signature" })
    signature: string

    @Column("varchar", { name: "status" })
    status: string

    @Column("varchar", { name: "hash" })
    hash: string

    @Column("integer", { name: "confirmations" })
    confirmations: number
}
