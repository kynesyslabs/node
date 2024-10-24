import { pki } from "node-forge"
import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"


@Entity("blocks")
export class Blocks {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("integer", { name: "number" })
    number: number

    @Column("varchar", { name: "hash" })
    hash: string

    @Column("json", { name: "content" })
    content: NonNullable<any>

    @Column("varchar", { name: "status" })
    status: string

    @Column("varchar", { name: "proposer" })
    proposer: pki.PublicKey | pki.ed25519.BinaryBuffer

    @Column("text", { name: "validation_data" })
    validation_data: string

}
