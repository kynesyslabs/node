import { Column, Entity, PrimaryColumn } from "typeorm"

@Entity("status_properties")
export class StatusProperties {
    @PrimaryColumn("text", { name: "address" })
    address: string | null

    @Column("text", { name: "tokens", nullable: true })
    tokens: string | null

    @Column("text", { name: "nfts", nullable: true })
    nfts: string | null

    @Column("text", { name: "xm", nullable: true })
    xm: string | null

    @Column("text", { name: "web2", nullable: true })
    web2: string | null

    @Column("text", { name: "other", nullable: true })
    other: string | null
}
