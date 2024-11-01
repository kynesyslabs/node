import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm"

@Entity("gcr_hashes")
export class GCRHashes {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("integer", { name: "block", nullable: true })
    block: number | null

    @Column("text", { name: "hash" })
    hash: string | null
}
