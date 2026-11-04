import { BlockContent } from "@kynesyslabs/demosdk/types"
import { pki } from "node-forge"
import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm"

@Entity("blocks")
@Index("idx_blocks_number", ["number"], { unique: true })
@Index("idx_blocks_hash", ["hash"])
export class Blocks {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("integer", { name: "number" })
    number: number

    @Column("varchar", { name: "hash" })
    hash: string

    @Column("json", { name: "content" })
    content: NonNullable<BlockContent>

    @Column("varchar", { name: "status" })
    status: string

    @Column("varchar", { name: "proposer" })
    proposer: pki.PublicKey | pki.ed25519.BinaryBuffer

    @Column("varchar", { name: "next_proposer" })
    next_proposer: string

    // round is the commitLock round the signatures were cast in; blocks
    // stored before the fork carry none.
    @Column("json", { name: "validation_data" })
    validation_data: NonNullable<{
        signatures: { [signer: string]: string }
        round?: number
    }>

    @Column("jsonb", { name: "attrs", nullable: true })
    attrs: Record<string, any> | null
}
