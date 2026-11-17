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
import { storageProgramsRoot } from "@/libs/blockchain/finality/storageRoot"

/**
 * UTF-8 byte order: what Postgres gives under the "C" collation, and what the
 * pinned Alpine image gives under its default one, since musl collates by
 * bytes. A glibc or ICU collation orders case and punctuation differently, so
 * the rows are sorted here and the hash does not depend on the database's
 * locale.
 */
function byKeyBytes<T>(key: (row: T) => string): (a: T, b: T) => number {
    return (a, b) =>
        Buffer.compare(Buffer.from(key(a), "utf8"), Buffer.from(key(b), "utf8"))
}

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
    records.sort(byKeyBytes(r => r.tx_hash))

    const tableString = JSON.stringify(records)
    return Hashing.sha256(tableString)
}

/**
 * The digest of the TLSN table rows. Before `tlsnVerified` it covers the
 * `createdAt` each node's database stamps, so it differs between nodes and
 * Sync leaves it out; that branch stays as it was, so old blocks keep their
 * hash. Under the fork it covers only what the chain wrote, the token and
 * proof columns, and no wall-clock field, so it is the same on every node.
 */
export function tlsnTableDigest(rows: GCRTLSNotary[], verified: boolean): string {
    const records = [...rows].sort(byKeyBytes(r => r.tokenId))
    if (!verified) {
        return Hashing.sha256(
            JSON.stringify(
                records.map(r => ({
                    tokenId: r.tokenId,
                    owner: r.owner,
                    domain: r.domain,
                    proof: r.proof,
                    storageType: r.storageType,
                    txhash: r.txhash,
                    proofTimestamp: String(r.proofTimestamp),
                    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
                })),
            ),
        )
    }
    const int = (v: number | string | null | undefined) =>
        v === null || v === undefined ? null : Number(v)
    return Hashing.sha256(
        JSON.stringify(
            records.map(r => ({
                tokenId: r.tokenId,
                owner: r.owner,
                domain: r.domain,
                status: r.status ?? null,
                requestHeight: int(r.requestHeight),
                expiresAtHeight: int(r.expiresAtHeight),
                proof: r.proof ?? null,
                storageType: r.storageType ?? null,
                txhash: r.txhash,
                proofTimestamp: String(r.proofTimestamp),
                attestationId: r.attestationId ?? null,
                storedAtHeight: int(r.storedAtHeight),
            })),
        ),
    )
}

/** SHA-256 of the TLSN table as it stands before the block at `blockHeight` applies. */
export async function hashTLSNotaryTable(
    blockHeight: number = getSharedState.lastBlockNumber ?? 0,
): Promise<string> {
    const db = await Datasource.getInstance()
    const repository = db.getDataSource().getRepository(GCRTLSNotary)

    const records = await repository.find({
        order: {
            tokenId: "ASC",
        },
    })
    return tlsnTableDigest(records, isForkActive("tlsnVerified", blockHeight))
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
    const tlsnotaryHash = await hashTLSNotaryTable(blockHeight)
    const hashes = {
        native_subnets_txs: subnetsTxsHash,
        native_tlsnotary: tlsnotaryHash,
    } as NativeTablesHashes & {
        native_atomic_work?: string
        native_storage_programs?: string
    }
    // Only from the fork on: an extra key changes the hash of every block
    // that carries it, and blocks before the fork must keep theirs.
    if (isForkActive("atomicWork", blockHeight)) {
        hashes.native_atomic_work = await hashAtomicWorkTables()
    }
    // A provable root rather than a flat hash: a client checks one program
    // against it without the rest of the table.
    if (isForkActive("finalityProofs", blockHeight)) {
        hashes.native_storage_programs = await storageProgramsRoot()
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
    works.sort(byKeyBytes(w => w.workId))
    slots.sort(byKeyBytes(s => s.resourceKey))
    writes.sort(byKeyBytes(w => w.storageAddress))

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
