import { Column, Entity } from "typeorm"

@Entity("pgp_key_server")
export class PgpKeyServer {
    @Column("text", { name: "key" })
    key: string

    @Column("text", { name: "email", nullable: true })
    email: string | null

    @Column("text", { name: "address", nullable: true })
    address: string | null

    @Column("text", { name: "others", nullable: true })
    others: string | null
}
