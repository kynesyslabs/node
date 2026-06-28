import type { TransactionContent } from "@kynesyslabs/demosdk/types"
import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm"
import { bigintNumericTransformer } from "./transformers"
import type { TransactionStatus } from "@/utilities/constants"

@Entity("transactions")
@Index("idx_transactions_hash", ["hash"])
@Index("idx_transactions_blockNumber", ["blockNumber"])
@Index("idx_transactions_from_ed25519_address", ["from_ed25519_address"])
@Index("idx_transactions_to", ["to"])
export class Transactions {
    @PrimaryGeneratedColumn({ type: "integer", name: "id" })
    id: number

    @Column("integer", { name: "blockNumber" })
    blockNumber: number

    @Column("varchar", { name: "signature" })
    signature: string

    @Column("varchar", { name: "ed25519_signature", nullable: true })
    ed25519_signature: string

    @Column("varchar", { name: "status" })
    status: string | TransactionStatus

    @Column("varchar", { name: "hash", unique: true })
    hash: string

    @Column("json", { name: "content" })
    content: NonNullable<any>

    @Column("varchar", { name: "type" })
    type: TransactionContent["type"]

    @Column("varchar", { name: "from" })
    from: string

    @Column("varchar", { name: "from_ed25519_address", nullable: true })
    from_ed25519_address: string

    @Column("varchar", { name: "to" })
    to: string

    // Widened from PG `bigint` (int8, max ~9.2e18) to `numeric(38, 0)` so
    // post-fork OS values fit. A 10% transfer out of the production
    // genesis-funded 10^18 DEM account is 10^17 DEM × 10^9 OS/DEM = 10^26
    // OS — three orders of magnitude past `int8`'s ceiling, which manifests
    // at block-insert time as `value "1e26" is out of range for type bigint`
    // and crashes the consensus loop. `numeric(38, 0)` matches
    // `gcr_main.balance` (see PR that introduced bigintNumericTransformer)
    // and shares its transformer so the application-level type stays
    // `bigint` end-to-end.
    @Column({
        type: "numeric",
        name: "amount",
        precision: 38,
        scale: 0,
        nullable: true,
        transformer: bigintNumericTransformer,
    })
    amount: bigint

    @Column("bigint", { name: "nonce", nullable: true, default: 0 })
    nonce: number

    @Column("bigint", { name: "timestamp" })
    timestamp: number

    // Fee columns: same widening rationale as `amount`. `nullable: true,
    // default: 0` retained — older databases predate the entity
    // declaration and may have NULL fee rows; readers already coerce
    // via `BigInt(... ?? 0)` so a NULL is observed as 0 throughout
    // the stack.
    @Column({
        type: "numeric",
        name: "networkFee",
        precision: 38,
        scale: 0,
        nullable: true,
        default: "0",
        transformer: bigintNumericTransformer,
    })
    networkFee: bigint | null

    @Column({
        type: "numeric",
        name: "rpcFee",
        precision: 38,
        scale: 0,
        nullable: true,
        default: "0",
        transformer: bigintNumericTransformer,
    })
    rpcFee: bigint | null

    @Column({
        type: "numeric",
        name: "additionalFee",
        precision: 38,
        scale: 0,
        nullable: true,
        default: "0",
        transformer: bigintNumericTransformer,
    })
    additionalFee: bigint | null

    // DEM-665: ed25519 public key (lowercase hex, `0x` + 64 hex chars) of
    // the RPC node that validated this transaction. Used by the
    // post-fork fee-distribution logic to route the rpc-fee portion to
    // the correct account.
    //
    // `nullable: true`: pre-fork rows predate the field (post-wipe
    // chains should have none, but the column shape is defensive). On a
    // post-fork tx, the validating node sets this in confirmTransaction
    // (DEM-665 P6). The column type is `varchar` for symmetry with the
    // other hex-address columns on this entity (`from`, `to`,
    // `from_ed25519_address`).
    @Column("varchar", { name: "rpcAddress", nullable: true })
    rpcAddress: string | null
}
