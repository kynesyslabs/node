import { Column, Entity, PrimaryColumn } from "typeorm"
import type { EncryptedTransaction } from "@kynesyslabs/demosdk/types"
/* INFO
    Subnet transactions (l2ps) are stored in a native table so they are synced with the rest of the chain.
    The transactions are indexed by the tx hash, the subnet id, the status and the block hash and number.
    This allows for a quick lookup to the transaction details and the block they were included in.
*/

@Entity("global_change_registry_subnets_txs")
export class GCRSubnetsTxs {
    @PrimaryColumn("text", { name: "tx_hash" })
    tx_hash: string

    @Column("text", { name: "subnet_id" })
    subnet_id: string

    @Column("text", { name: "status" })
    status: string

    @Column("text", { name: "block_hash" })
    block_hash: string

    @Column("integer", { name: "block_number" })
    block_number: number

    @Column("json", { name: "tx_data"})
    tx_data: EncryptedTransaction
}
