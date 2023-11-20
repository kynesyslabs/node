import { Column, Entity } from "typeorm"

@Entity("status_native")
export class StatusNative {
    @Column("text", { name: "address", nullable: true })
    address: string | null

    @Column("text", { name: "balance", nullable: true })
    balance: number | null

    @Column("integer", { name: "nonce", nullable: true })
    nonce: number | null

    @Column("text", { name: "tx_list", nullable: true })
    tx_list: string | null
}
