import { Column, Entity, PrimaryColumn } from "typeorm"

@Entity("status_hashes")
export class StatusHashes {
    @Column("integer", { name: "block", nullable: true })
    block: number | null

    @PrimaryColumn("text", { name: "hash" })
    hash: string | null
}
