import {
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
} from "typeorm"

// REVIEW: GCR_StorageProgram entity for unified JSON/Binary storage

// Type definitions matching SDK types to avoid import resolution issues
type StorageEncoding = "json" | "binary"
type StorageLocation = "onchain" | "ipfs"
type StorageACLMode = "owner" | "public" | "restricted"
interface StorageGroupPermissions {
    members: string[]
    permissions: ("read" | "write" | "delete")[]
}
interface StorageProgramACL {
    mode: StorageACLMode
    allowed?: string[]
    blacklisted?: string[]
    groups?: Record<string, StorageGroupPermissions>
}

/**
 * GCR StorageProgram Entity
 *
 * Stores data for StorageProgram transactions with support for:
 * - JSON (structured key-value) or Binary (base64 raw) encoding
 * - Robust ACL: owner, allowed, blacklisted, public, groups
 * - Max 1MB data, priced at 1 DEM per 10KB
 * - IPFS-ready with storageLocation and ipfsCid fields (stubs for future)
 *
 * @see feature_storage_programs_plan.md for specification
 */
@Entity("gcr_storageprogram")
@Index("idx_gcr_storageprogram_owner", ["owner"])
@Index("idx_gcr_storageprogram_programname", ["programName"])
@Index("idx_gcr_storageprogram_encoding", ["encoding"])
@Index("idx_gcr_storageprogram_storagelocation", ["storageLocation"])
export class GCRStorageProgram {
    /**
     * Unique storage address (stor-{sha256(deployer:name:salt).substring(0,40)})
     */
    @PrimaryColumn({ type: "text", name: "storageAddress" })
    storageAddress: string

    /**
     * Owner address (deployer who created the storage program)
     */
    @Column({ type: "text", name: "owner" })
    owner: string

    /**
     * Human-readable name for the storage program
     */
    @Column({ type: "text", name: "programName" })
    programName: string

    /**
     * Encoding format: "json" for structured data, "binary" for raw base64
     */
    @Column({ type: "text", name: "encoding" })
    encoding: StorageEncoding

    /**
     * Stored data - either JSON object or base64 string depending on encoding
     * For JSON: Record<string, any> (max 64 nesting levels)
     * For Binary: base64 encoded string
     */
    @Column({ type: "jsonb", name: "data", nullable: true })
    data: Record<string, unknown> | string | null

    /**
     * Size of the data in bytes (used for fee calculation)
     */
    @Column({ type: "integer", name: "sizeBytes" })
    sizeBytes: number

    /**
     * Robust Access Control List
     * Contains: mode, allowed, blacklisted, groups
     */
    @Column({ type: "jsonb", name: "acl" })
    acl: StorageProgramACL

    /**
     * Optional metadata (filename, mimeType, description, etc.)
     */
    @Column({ type: "jsonb", name: "metadata", nullable: true })
    metadata: Record<string, unknown> | null

    /**
     * Storage location: "onchain" (current) or "ipfs" (future)
     */
    @Column({ type: "text", name: "storageLocation", default: "onchain" })
    storageLocation: StorageLocation

    /**
     * IPFS Content Identifier (stub for future IPFS integration)
     * Will contain CID when storageLocation is "ipfs"
     */
    @Column({ type: "text", name: "ipfsCid", nullable: true })
    ipfsCid: string | null

    /**
     * Optional salt used in address derivation
     */
    @Column({ type: "text", name: "salt", nullable: true })
    salt: string | null

    /**
     * Transaction hash that created this storage program
     */
    @Column({ type: "text", name: "createdByTx" })
    createdByTx: string

    /**
     * Transaction hash of the last modification (write/update)
     */
    @Column({ type: "text", name: "lastModifiedByTx" })
    lastModifiedByTx: string

    /**
     * Total fees paid for this storage program (cumulative)
     */
    @Column({
        type: "bigint",
        name: "totalFeesPaid",
        transformer: {
            to: (v: bigint) => v.toString(),
            from: (v: string | number) => BigInt(v),
        },
    })
    totalFeesPaid: bigint

    /**
     * Whether this storage program has been deleted (soft delete)
     */
    @Column({ type: "boolean", name: "isDeleted", default: false })
    isDeleted: boolean

    /**
     * Transaction hash that deleted this program (if deleted)
     */

    /**
     * Array of all transaction hashes that interacted with this storage program
     * Provides complete history of modifications
     */
    @Column({ type: "simple-array", name: "interactionTxs", default: "" })
    interactionTxs: string[]

    @Column({ type: "text", name: "deletedByTx", nullable: true })
    deletedByTx: string | null

    @CreateDateColumn({ type: "timestamp", name: "createdAt" })
    createdAt: Date

    @UpdateDateColumn({ type: "timestamp", name: "updatedAt" })
    updatedAt: Date
}
