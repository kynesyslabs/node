import { Column, Entity, PrimaryColumn } from "typeorm"

@Entity("validators")
export class Validators {
    @PrimaryColumn("text", { name: "address" })
    address: string | null

    @Column("text", { name: "status", nullable: true })
    status: string | null

    @Column("text", { name: "connection_url", nullable: true })
    connectionUrl: string | null

    @Column("text", { name: "staked", nullable: true })
    staked: string | null

    @Column("integer", { name: "first_seen", nullable: true })
    firstSeen: number | null

    @Column("integer", { name: "valid_at", nullable: true })
    validAt: number | null
}
