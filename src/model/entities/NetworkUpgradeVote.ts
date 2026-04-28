import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    Unique,
} from "typeorm"

/**
 * A single validator's vote on a proposal. One row per (proposalId, voter).
 * Votes are final — no updates.
 */
@Entity("network_upgrade_votes")
@Unique("uq_proposal_voter", ["proposalId", "voterAddress"])
export class NetworkUpgradeVote {
    @PrimaryGeneratedColumn()
    id: number

    @Column("text", { name: "proposal_id" })
    @Index()
    proposalId: string

    /** Voter's validator public key (ed25519 hex). */
    @Column("text", { name: "voter_address" })
    voterAddress: string

    @Column("boolean", { name: "approve" })
    approve: boolean

    /**
     * Vote weight = voter's staked DEMOS at snapshot block. bigint-as-string.
     * Frozen at recording time so tally is deterministic even if the voter
     * unstakes later during the lock period.
     */
    @Column("text", { name: "weight" })
    weight: string

    /** Block in which the vote tx was confirmed. */
    @Column("integer", { name: "block_number" })
    blockNumber: number

    @CreateDateColumn({ name: "created_at" })
    createdAt: Date
}
