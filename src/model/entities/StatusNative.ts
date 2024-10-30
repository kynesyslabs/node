import { StoredIdentities } from "@kynesyslabs/demosdk/types"
import { Column, Entity, PrimaryColumn } from "typeorm"

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
    identities: StoredIdentities | null
}
