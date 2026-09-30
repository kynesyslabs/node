/**
 * L2PS Executed Hashes Entity
 *
 * @module L2PSExecutedHashes
 */

import { Entity, Column, PrimaryColumn, CreateDateColumn } from "typeorm"

/**
 * The original hash of every subnet transaction whose history row was pruned.
 *
 * `l2ps_transactions` is what the replay check consults, and retention deletes
 * from it. Without this record a pruned transfer's envelope — which peers and
 * clients have had a copy of all along — would be accepted and paid out again.
 * Only the hash is kept: it says nothing about the parties or the payload, so
 * it does not undo what retention is for.
 */
@Entity("l2ps_executed_hashes")
export class L2PSExecutedHash {
    /** Original (pre-encryption) transaction hash */
    @PrimaryColumn("text")
    hash: string

    @Column("text")
    l2ps_uid: string

    @CreateDateColumn()
    pruned_at: Date
}
