import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from "typeorm"
import type {
    NetworkParameters,
    ProposalStatus,
} from "@/features/networkUpgrade/types"

/**
 * A network-upgrade proposal. Written at proposal-tx confirmation, updated
 * at tally-block (pending → approved/rejected), at grace-period start
 * (approved → activating), and at effectiveAtBlock (activating → active).
 */
@Entity("network_upgrades")
export class NetworkUpgrade {
    @PrimaryGeneratedColumn()
    id: number

    /** UUID; unique across all proposals. */
    @Column("text", { name: "proposal_id", unique: true })
    @Index()
    proposalId: string

    /** Monotonically increasing per-proposal label. */
    @Column("integer", { name: "version" })
    version: number

    @Column("text", { name: "proposer_public_key" })
    proposerPublicKey: string

    /** Only the keys the proposer wants to change. Stored as JSONB. */
    @Column("jsonb", { name: "proposed_parameters" })
    proposedParameters: Partial<NetworkParameters>

    @Column("text", { name: "status" })
    @Index()
    status: ProposalStatus

    /** Block at which the proposal tx was confirmed. */
    @Column("integer", { name: "snapshot_block" })
    snapshotBlock: number

    /** Block at which votes are tallied. = snapshotBlock + VOTING_WINDOW_BLOCKS. */
    @Column("integer", { name: "tally_block" })
    tallyBlock: number

    /** Block at which approved proposals activate. */
    @Column("integer", { name: "effective_at_block" })
    @Index()
    effectiveAtBlock: number

    @Column("text", { name: "rationale" })
    rationale: string

    @CreateDateColumn({ name: "created_at" })
    createdAt: Date
}
