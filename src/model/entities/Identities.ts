import { pki } from "node-forge"
import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"


type ProviderIdentities = Map<string, string[]> // NOTE The key is the provider name and the value is an array of public identifiers

type Context = "xm"|"web2"

type StoredIdentities = {
    [key in Context]: ProviderIdentities
} // Example: { xm: { "provider1": ["public_identifier1", "public_identifier2"], "provider2": ["public_identifier3"] }, web2: { "provider1": ["public_identifier4"], "provider2": ["public_identifier5", "public_identifier6"] } }

@Entity("identities")
export class Identities {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("varchar", { name: "public_key" })
    public_key: pki.PublicKey | pki.ed25519.BinaryBuffer | string // ? We need to check if this is the best way to store the public key

    @Column("json", { name: "identities" })
    identities: StoredIdentities
}
