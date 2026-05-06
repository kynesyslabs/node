/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Column, Entity, PrimaryColumn } from "typeorm"

// REVIEW: P3b — persistent fork-activation ledger.
//
// One row per fork. `applied=true` is the idempotent gate consumed by the
// block-acceptance hook (see `Chain.insertBlock` / `chainBlocks.insertBlock`)
// to ensure the state migration runs at most once per chain.
//
// The column set doubles as a forensic audit trail: counts and pre/post
// balance sums are recorded so an operator can replay the math after the
// fact. Sums and the cap-policy "value lost" are persisted as text to avoid
// `Number.MAX_SAFE_INTEGER` precision loss for OS-magnitude bigints.
@Entity("fork_state")
export class ForkState {
    @PrimaryColumn("text", { name: "fork_name" })
    forkName: string

    @Column("boolean", { name: "applied", default: false })
    applied: boolean

    @Column("bigint", { name: "applied_at_block", nullable: true })
    appliedAtBlock: bigint | null

    @Column("timestamp", { name: "applied_at", nullable: true })
    appliedAt: Date | null

    // Sum invariants (stringified bigints to avoid JS number precision loss
    // when the post-fork supply is ~10^9× the pre-fork supply).
    @Column("text", { name: "pre_sum_dem", nullable: true })
    preSumDem: string | null

    @Column("text", { name: "post_sum_os", nullable: true })
    postSumOs: string | null

    // Per-table row counts seen at migration time. Forensic.
    @Column("integer", { name: "gcr_v2_row_count", nullable: true })
    gcrV2RowCount: number | null

    @Column("integer", { name: "legacy_row_count", nullable: true })
    legacyRowCount: number | null

    @Column("integer", { name: "validators_row_count", nullable: true })
    validatorsRowCount: number | null

    // Cap policy forensics (legacy GCR backend only — JSONB `number` column
    // cannot hold values > Number.MAX_SAFE_INTEGER without precision loss,
    // so accounts > ~9M DEM are capped at MAX_SAFE_INTEGER * 0.9 in OS).
    @Column("integer", { name: "capped_count", nullable: true })
    cappedCount: number | null

    @Column("text", { name: "total_value_lost_os", nullable: true })
    totalValueLostOs: string | null
}
