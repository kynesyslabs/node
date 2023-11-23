import { Column, Entity, PrimaryColumn } from "typeorm"

@Entity("consensus")
export class Consensus {
    @PrimaryColumn("integer", { name: "round" })
    round: number | null

    @Column("text", { name: "lastBlockHash", nullable: true })
    lastBlockHash: string | null

    @Column("text", { name: "lastBlockTimestamp", nullable: true })
    lastBlockTimestamp: string | null

    @Column("text", { name: "lastConsensusHash", nullable: true })
    lastConsensusHash: string | null

    @Column("text", { name: "validators", nullable: true })
    validators: string | null

    @Column("text", { name: "reports", nullable: true })
    reports: string | null
}
