import { Column, Entity, PrimaryColumn } from "typeorm"

@Entity("pgp_key_server")
export class PgpKeyServer {
    @PrimaryColumn("text", { name: "key" })
    key: string

    @Column("text", { name: "email", nullable: true })
    email: string | null

    @Column("text", { name: "address", nullable: true })
    address: string | null

    @Column("text", { name: "others", nullable: true })
    others: string | null
}
