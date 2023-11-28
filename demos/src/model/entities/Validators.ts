import { Column, Entity, PrimaryColumn } from "typeorm"

@Entity("validators")
export class Validators {
    @PrimaryColumn("text", { name: "address" })
    address: string | null

    @Column("text", { name: "status", nullable: true })
    status: string | null

    @Column("text", { name: "connection_url", nullable: true })
    connection_url: string | null

    @Column("text", { name: "staked", nullable: true })
    staked: string | null

    @Column("integer", { name: "first_seen", nullable: true })
    first_seen: number | null

    @Column("integer", { name: "valid_at", nullable: true })
    valid_at: number | null

    @Column("integer", { name: "stake", nullable: true })
    stake: number | null
}
