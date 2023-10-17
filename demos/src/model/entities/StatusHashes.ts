import { Column, Entity } from "typeorm"

@Entity("status_hashes")
export class StatusHashes {
    @Column("integer", { name: "block", nullable: true })
    block: number | null

    @Column("text", { name: "hash", nullable: true })
    hash: string | null
}
