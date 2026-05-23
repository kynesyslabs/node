import { Column, Entity, Index, PrimaryColumn } from "typeorm"

@Entity("validators")
export class Validators {
    @PrimaryColumn("text", { name: "address" })
    address: string | null

    @Column("text", { name: "status", nullable: true })
    status: string | null

    @Column("text", { name: "connection_url", nullable: true })
    connection_url: string | null

    /** Current staked amount as a bigint-as-string. Authoritative. */
    @Column("text", { name: "staked_amount", nullable: true, default: "0" })
    staked_amount: string | null

    @Column("integer", { name: "first_seen", nullable: true })
    first_seen: number | null

    @Column("integer", { name: "valid_at", nullable: true })
    valid_at: number | null

    /** Block at which the validator requested to unstake, or null. */
    @Column("integer", { name: "unstake_requested_at", nullable: true })
    @Index()
    unstake_requested_at: number | null

    /** Block at which the validator can call validatorExit, or null. */
    @Column("integer", { name: "unstake_available_at", nullable: true })
    @Index()
    unstake_available_at: number | null
}
