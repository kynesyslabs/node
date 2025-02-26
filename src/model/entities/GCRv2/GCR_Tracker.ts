import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm"
import { StoredIdentities } from "../types/IdentityTypes"
// Define the shape of your JSON data

// TODO Implement this
@Entity("gcr_tracker")
export class GCRTracker {
    @PrimaryColumn({ type: "text", name: "txhash" })
    txhash: string
    @Column({ type: "boolean", name: "applied" })
    applied: boolean
}