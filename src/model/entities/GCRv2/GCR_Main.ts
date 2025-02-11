import { Column, Entity, PrimaryColumn } from "typeorm"
import { StoredIdentities } from "../types/IdentityTypes"
// Define the shape of your JSON data


@Entity("gcr_main")
export class GCR_Main {
    @PrimaryColumn({ type: "text", name: "pubkey" })
    pubkey: string
    @Column({ type: "jsonb", name: "assignedTxs" })
    assignedTxs: string[]
    @Column({ type: "integer", name: "nonce" })
    nonce: number
    @Column({ type: "integer", name: "balance" })
    balance: number
    @Column({ type: "jsonb", name: "identities" })
    identities: StoredIdentities
}