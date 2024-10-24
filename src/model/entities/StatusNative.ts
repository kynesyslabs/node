import { Column, Entity, PrimaryColumn } from "typeorm"

// SECTION Types

type Identity = { // NOTE This supports both chains and web2 contexts
    public_identifier: string
    context: "xm" | "web2"
}

type StoredIdentities = Map<string, Identity> // NOTE The key is the network name or the web2 context name

// SECTION Entity

@Entity("status_native")
export class StatusNative {
    @PrimaryColumn("text", { name: "address" })
    address: string | null

    @Column("text", { name: "balance", nullable: true })
    balance: number | null

    @Column("integer", { name: "nonce", nullable: true })
    nonce: number | null

    @Column("text", { name: "tx_list", nullable: true })
    tx_list: string | null

    @Column("json", { name: "identities", nullable: true })
    identities: StoredIdentities | null = new Map() // NOTE This is a map of the public identifiers and the context
}
