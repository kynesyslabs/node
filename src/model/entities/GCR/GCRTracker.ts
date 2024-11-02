import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"
import { StoredIdentities } from "../types/IdentityTypes"

/* NOTE
    This table is used to track the changes in the GCR.
    Each time a GlobalChangeRegistry is updated, the corresponding updated hash is stored in this table.
    This is used to know if the GCR has changed or not when querying the GCR.
*/

// SECTION Entities

@Entity("gcr_tracker")
export class GCRTracker {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("text", { name: "public_key" })
    publicKey: string

    @Column("text", { name: "hash" })
    hash: string
}
