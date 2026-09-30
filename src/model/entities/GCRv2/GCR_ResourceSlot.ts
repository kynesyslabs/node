import { Column, Entity, Index, PrimaryColumn } from "typeorm"

import type { SlotRecord } from "@/libs/atomic-work/workLedger"

/**
 * A contended resource slot. A missing row is a vacant slot at generation 0.
 *
 * `record` holds the full state, including the record it replaced, so a
 * block rollback restores the prior state exactly; the other columns are
 * copies for lookup.
 */
@Entity("gcr_resource_slots")
@Index("idx_gcr_resource_slots_work", ["workId"])
export class GCRResourceSlot {
    @PrimaryColumn({ type: "text", name: "resourceKey" })
    resourceKey: string

    @Column({ type: "text", name: "state" })
    state: string

    @Column({ type: "integer", name: "generation" })
    generation: number

    @Column({ type: "text", name: "workId" })
    workId: string

    @Column({ type: "jsonb", name: "record" })
    record: SlotRecord
}
