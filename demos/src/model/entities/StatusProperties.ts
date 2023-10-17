import { Column, Entity } from "typeorm"

@Entity("status_properties")
export class StatusProperties {
    @Column("text", { name: "address", nullable: true })
    address: string | null

    @Column("text", { name: "tokens", nullable: true })
    tokens: string | null

    @Column("text", { name: "nfts", nullable: true })
    nfts: string | null

    @Column("text", { name: "other", nullable: true })
    other: string | null
}
