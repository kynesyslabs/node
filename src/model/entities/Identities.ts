import { pki } from "node-forge"
import { Column, Entity, PrimaryGeneratedColumn } from "typeorm"

type Identity = { // NOTE This supports both chains and web2 contexts
    public_identifier: string
    context: "xm" | "web2"
}

type StoredIdentities = Map<string, Identity> // NOTE The key is the network name or the web2 context name

@Entity("identities")
export class Identities {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("varchar", { name: "public_key" })
    public_key: pki.PublicKey | pki.ed25519.BinaryBuffer | string // ? We need to check if this is the best way to store the public key

    @Column("json", { name: "identities" })
    identities: StoredIdentities
}
