import { EntityTarget, Repository, FindOptionsOrder } from "typeorm"
import Datasource from "../../../../model/datasource"
import Hashing from "src/libs/crypto/hashing"
import { GCRSubnetsTxs } from "../../../../model/entities/GCRv2/GCRSubnetsTxs"
import { GCRTLSNotary } from "../../../../model/entities/GCRv2/GCR_TLSNotary"
import { GCRHashes } from "../../../../model/entities/GCRv2/GCRHashes"
import Chain from "src/libs/blockchain/chain"
import { type NativeTablesHashes } from "@kynesyslabs/demosdk/types"
import { isForkActive } from "@/forks"
import { jcsCanonicalize } from "@/libs/crypto/jcs"
import { GCRAtomicWork } from "@/model/entities/GCRv2/GCR_AtomicWork"
import { GCRResourceSlot } from "@/model/entities/GCRv2/GCR_ResourceSlot"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import { getSharedState } from "@/utilities/sharedState"

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
export async function hashPublicKeyTable<T extends { public_key: string }>(
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

// REVIEW: TLSNotary proofs table hash for integrity verification
/**
 * Generates a SHA-256 hash for the GCRTLSNotary table.
 * Orders by tokenId for deterministic hashing.
 *
 * @returns Promise<string> - SHA-256 hash of the TLSNotary proofs table
 */
export async function hashTLSNotaryTable(): Promise<string> {
    const db = await Datasource.getInstance()
    const repository = db.getDataSource().getRepository(GCRTLSNotary)

    const records = await repository.find({
        order: {
            tokenId: "ASC",
        },
    })

    // Normalize to plain objects with fixed field order for deterministic hashing
    const normalized = records.map(r => ({
        tokenId: r.tokenId,
        owner: r.owner,
        domain: r.domain,
        proof: r.proof,
        storageType: r.storageType,
        txhash: r.txhash,
        proofTimestamp: String(r.proofTimestamp),
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    }))

    return Hashing.sha256(JSON.stringify(normalized))
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
export default async function hashGCRTables(
    blockHeight: number = getSharedState.lastBlockNumber ?? 0,
): Promise<NativeTablesHashes> {
    // Get all individual hashes
    // REVIEW: The below was GCRTracker without "", which was causing an error as is not an entity
    const subnetsTxsHash = await hashSubnetsTxsTable()
    // REVIEW: TLSNotary proofs included in GCR integrity hash
    const tlsnotaryHash = await hashTLSNotaryTable()
    const hashes = {
        native_subnets_txs: subnetsTxsHash,
        native_tlsnotary: tlsnotaryHash,
    } as NativeTablesHashes & { native_atomic_work?: string }
    // Only from the fork on: an extra key changes the hash of every block
    // that carries it, and blocks before the fork must keep theirs.
    if (isForkActive("atomicWork", blockHeight)) {
        hashes.native_atomic_work = await hashAtomicWorkTables()
    }
    return hashes
}

/**
 * Hash of the state Works commit: winners and receipts, resource slots, and
 * the storage entries Works wrote. Folded into the block hash so validators
 * whose Work state diverged cannot agree on a block.
 */
export async function hashAtomicWorkTables(): Promise<string> {
    const db = (await Datasource.getInstance()).getDataSource()

    const works = await db
        .getRepository(GCRAtomicWork)
        .find({ order: { workId: "ASC" } })
    const slots = await db
        .getRepository(GCRResourceSlot)
        .find({ order: { resourceKey: "ASC" } })
    const writes = await db
        .getRepository(GCRStorageProgram)
        .createQueryBuilder("sp")
        .where("sp.metadata -> 'atomicWork' IS NOT NULL")
        .orderBy("sp.storageAddress", "ASC")
        .getMany()

    // JCS, because slot records and stored values come back from jsonb with
    // their keys in the database's order, not the order they were written.
    return Hashing.sha256(
        jcsCanonicalize({
            works: works.map(w => ({ ...w })),
            slots: slots.map(s => s.record),
            writes: writes.map(w => ({
                storageAddress: w.storageAddress,
                owner: w.owner,
                data: w.data ?? null,
                lastModifiedByTx: w.lastModifiedByTx,
                isDeleted: w.isDeleted,
            })),
        }),
    )
}

/**
 * Inserts a GCR hash into the database.
 * If no hash is provided, it will generate a new one using hashGCRTables().
 *
 * @param hash - Optional: SHA-256 hash of the GCR tables
 * @returns Promise<void>
 */
export async function insertGCRHash(hash?: NativeTablesHashes): Promise<void> {
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
