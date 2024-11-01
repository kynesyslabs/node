import { EntityTarget, Repository, FindOptionsOrder } from "typeorm"
import Datasource from "../../../../model/datasource"
import Hashing from "src/libs/crypto/hashing"
import { GCRSubnetsTxs } from "../../../../model/entities/GCR/GCRSubnetsTxs"
import { GlobalChangeRegistry } from "../../../../model/entities/GCR/GlobalChangeRegistry"
import { GCRExtended } from "../../../../model/entities/GCR/GCRExtended"
import { GCRHashes } from "../../../../model/entities/GCR/GCRHashes"
import Chain from "src/libs/blockchain/chain"

/**
 * Generates a SHA-256 hash for tables that use 'publicKey' as their identifier.
 * The hash is created by:
 * 1. Ordering all records by publicKey (ASC)
 * 2. Converting the ordered records to JSON
 * 3. Creating a SHA-256 hash of the JSON string
 * 
 * @param entity - The TypeORM entity to hash (must have a publicKey property)
 * @returns Promise<string> - SHA-256 hash of the table contents
 */
export async function hashPublicKeyTable<T extends { publicKey: string }>(
    entity: EntityTarget<T>,
): Promise<string> {
    const db = await Datasource.getInstance()
    const repository: Repository<T> = db.getDataSource().getRepository(entity)

    const records = await repository.find({
        order: {
            publicKey: "ASC",
        } as unknown as FindOptionsOrder<T>,
    })

    const tableString = JSON.stringify(records)
    return Hashing.sha256(tableString)
}

/**
 * Generates a SHA-256 hash specifically for the GCRSubnetsTxs table.
 * Similar to hashPublicKeyTable, but orders by tx_hash instead of publicKey.
 * Used separately because GCRSubnetsTxs has a different primary key structure.
 * 
 * @returns Promise<string> - SHA-256 hash of the GCRSubnetsTxs table contents
 */
export async function hashSubnetsTxsTable(): Promise<string> {
    const db = await Datasource.getInstance()
    const repository = db.getDataSource().getRepository(GCRSubnetsTxs)

    const records = await repository.find({
        order: {
            tx_hash: "ASC",
        },
    })

    const tableString = JSON.stringify(records)
    return Hashing.sha256(tableString)
}

/**
 * Creates a combined hash of all GCR-related tables.
 * Process:
 * 1. Gets individual hashes for each GCR table
 * 2. Combines them in a deterministic order using a JSON object
 * 3. Creates a final SHA-256 hash of the combined string
 * 
 * This ensures that any change in any GCR table will result in a different final hash.
 * The deterministic ordering ensures consistency across different runs.
 * 
 * @returns Promise<string> - Combined SHA-256 hash of all GCR tables
 */
export default async function hashGCRTables(): Promise<string> {
    
    // Get all individual hashes
    const gcrHash = await hashPublicKeyTable(GlobalChangeRegistry)
    const gcrExtendedHash = await hashPublicKeyTable(GCRExtended)
    const subnetsTxsHash = await hashSubnetsTxsTable()

    // Combine all hashes in a deterministic order using a JSON object
    // The object keys are sorted alphabetically to ensure consistent ordering
    const combinedString = JSON.stringify({
        gcr: gcrHash,
        gcrExtended: gcrExtendedHash,
        subnets: subnetsTxsHash,
    })

    // Create final hash of the combined string
    return Hashing.sha256(combinedString)
}

/**
 * Inserts a GCR hash into the database.
 * If no hash is provided, it will generate a new one using hashGCRTables().
 * 
 * @param hash - Optional: SHA-256 hash of the GCR tables
 * @returns Promise<void>
 */
export async function insertGCRHash(hash?: string): Promise<void> {
    const db = await Datasource.getInstance()
    const repository = db.getDataSource().getRepository(GCRHashes)

    if (!hash) {
        hash = await hashGCRTables()
    }

    // Get the latest block number
    const latestBlock = await Chain.getLastBlockNumber()

    const gcrHash = new GCRHashes()
    gcrHash.block = latestBlock
    gcrHash.hash = hash
    await repository.save(gcrHash)
}
