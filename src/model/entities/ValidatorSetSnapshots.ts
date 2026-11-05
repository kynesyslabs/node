/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Column, Entity, PrimaryColumn } from "typeorm"

/** One validator as the set record holds it. */
export interface ValidatorSetEntry {
    identity: string
    stake: string
    status: string | null
    validAt: number | null
}

/**
 * The validators table as it stood after `block` was inserted. A row exists
 * for block 0 and for every block that changed the set; the set at any
 * height is the row with the highest block at or below it. Consensus reads
 * these rows instead of the live table, whose past states are gone.
 */
@Entity("validator_set_snapshots")
export class ValidatorSetSnapshots {
    @PrimaryColumn("integer", { name: "block" })
    block: number

    /** sha256 of the JCS encoding of `validators`, lowercase hex. */
    @Column("text", { name: "set_hash" })
    setHash: string

    /** Sorted by identity; see `validatorSetRecord`. */
    @Column("jsonb", { name: "validators" })
    validators: ValidatorSetEntry[]
}
