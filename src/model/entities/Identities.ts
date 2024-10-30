import { pki } from "node-forge"
import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"
import { StoredIdentities } from "@kynesyslabs/demosdk/types"

@Entity("identities")
export class Identities {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("varchar", { name: "public_key" })
    public_key: pki.PublicKey | pki.ed25519.BinaryBuffer | string // ? We need to check if this is the best way to store the public key

    @Column("json", { name: "identities" })
    identities: StoredIdentities
}
