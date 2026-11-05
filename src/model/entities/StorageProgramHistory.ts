/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Column, Entity, PrimaryColumn } from "typeorm"
import type { StorageProgramRecord } from "@/libs/blockchain/finality/storageRecord"

/**
 * A storage program's record as it stood before `block` first changed it,
 * or null when the program did not exist yet. Kept for the last blocks only,
 * so storage proofs can be served against their committed roots.
 */
@Entity("storage_program_history")
export class StorageProgramHistory {
    @PrimaryColumn("integer", { name: "block" })
    block: number

    @PrimaryColumn("text", { name: "storageAddress" })
    storageAddress: string

    /** The record its leaf was computed from; see finality/storageRecord.ts. */
    @Column("jsonb", { name: "record", nullable: true })
    record: StorageProgramRecord | null
}
