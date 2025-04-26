import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"
import type { StoredIdentities } from "../types/IdentityTypes"
// Define the shape of your JSON data

// ! See https://poe.com/s/ud8vmCkiIHiNCaU7SYaP for efficient JSONB manipulation (and apply around the code)

// SECTION Interfaces

export interface GCRStatus {
    hash: string
    content: {
        balance: number // balance of the address
        identities: StoredIdentities // Identities that are linked to this address
        txs: string[] // hashes of the transactions pertaining to this address
        nonce: number // last nonce used by this address
    }
}

export interface GCRExtended {
    tokens: string[]
    nfts: string[]
    xm: string[]
    web2: string[]
    other: string[]
}

// SECTION Entities

@Entity("global_change_registry")
export class GlobalChangeRegistry {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("text", { name: "public_key" })
    publicKey: string

    @Column("jsonb", { name: "details" })
    details: GCRStatus

    @Column("jsonb", { name: "extended" })
    extended: GCRExtended
}
