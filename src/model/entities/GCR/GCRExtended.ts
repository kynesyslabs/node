import { Column, Entity, PrimaryColumn } from "typeorm"


// ! Typize the jsonb columns
@Entity("global_change_registry_extended")
export class GCRExtended {
    @PrimaryColumn("text", { name: "public_key" })
    publicKey: string | null

    @Column("jsonb", { name: "tokens", nullable: true })
    tokens: string | null

    @Column("jsonb", { name: "nfts", nullable: true })
    nfts: string | null

    @Column("jsonb", { name: "xm", nullable: true })
    xm: string | null

    @Column("jsonb", { name: "web2", nullable: true })
    web2: string | null

    @Column("jsonb", { name: "other", nullable: true })
    other: string | null
}
