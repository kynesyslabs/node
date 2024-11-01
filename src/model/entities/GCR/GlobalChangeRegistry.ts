import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"
import { StoredIdentities } from "../types/IdentityTypes"
// Define the shape of your JSON data
interface GCRStatus {
    hash: string
    content: {
        balance: number // balance of the address
        identities: StoredIdentities // Identities that are linked to this address
        txs: string[] // hashes of the transactions pertaining to this address
        nonce: number // last nonce used by this address
    }
}

@Entity("global_change_registry")
export class GlobalChangeRegistry {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("text", { name: "public_key" })
    publicKey: string

    @Column("jsonb", { name: "details" })
    details: GCRStatus
}
