import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"

@Entity("blocks")
export class Blocks {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("json", { name: "content" })
    content: NonNullable<any>

    @Column("integer", { name: "number" })
    number: number

    @Column("varchar", { name: "hash" })
    hash: string

    @Column("varchar", { name: "status" })
    status: string

    @Column("varchar", { name: "proposer" })
    proposer: string

    @Column("text", { name: "validation_data" })
    validationData: string
}
