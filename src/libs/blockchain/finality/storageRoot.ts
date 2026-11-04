/**
 * The storage state root: a sparse Merkle tree over every row of
 * `gcr_storageprogram`, keyed and valued as finality/storageRecord.ts defines.
 * It enters the block as `native_tables_hashes.native_storage_programs`, so
 * validators must compute it from committed state only, and get the same
 * value whether they forge, vote or sync.
 *
 * The root is a pure function of the table. Each row carries its leaf in
 * `smtLeaf`, written with the row in the block's database transaction, so a
 * rebuild reads one narrow column; a row without one (genesis restore,
 * migrated rows) has its leaf computed from the row and filled in. The root
 * is cached until a write to the table bumps the dirty epoch, so blocks that
 * write no storage program cost nothing.
 */

import { In, type EntityManager } from "typeorm"
import { Config } from "@/config"
import { SparseMerkleTree } from "@/libs/crypto/merkle/sparse"
import Datasource from "@/model/datasource"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import log from "src/utilities/logger"
import {
    storageProgramKey,
    storageProgramLeafHex,
    type StorageProgramRow,
} from "./storageRecord"

export interface StoredLeaf {
    storageAddress: string
    smtLeaf: string | null
    /** Row version, so a filled-in leaf never lands on a row changed since. */
    version: string
}

/** One consistent view of the table. */
export interface StorageRootSnapshot {
    leaves(): Promise<StoredLeaf[]>
    rows(addresses: string[]): Promise<StorageProgramRow[]>
}

export interface StorageRootReader {
    read<T>(work: (snapshot: StorageRootSnapshot) => Promise<T>): Promise<T>
    /** Stores computed leaves on rows that are still at `version`. */
    fillLeaves(leaves: StoredLeaf[]): Promise<void>
}

const ROW_BATCH = 200
const LEAF_HEX = /^[0-9a-f]{64}$/

export const isStoredLeaf = (leaf: string | null): leaf is string =>
    typeof leaf === "string" && LEAF_HEX.test(leaf)

async function leavesFromRows(
    snapshot: StorageRootSnapshot,
    addresses: string[],
): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (let i = 0; i < addresses.length; i += ROW_BATCH) {
        const batch = addresses.slice(i, i + ROW_BATCH)
        const rows = await snapshot.rows(batch)
        for (const row of rows) out.set(row.storageAddress, storageProgramLeafHex(row))
        const missing = batch.filter(address => !out.has(address))
        if (missing.length > 0) {
            throw new Error(`storage root: rows vanished inside one snapshot: ${missing.slice(0, 3).join(", ")}`)
        }
    }
    return out
}

function rootOf(leaves: Iterable<[string, string]>): string {
    const entries = []
    for (const [storageAddress, leaf] of leaves) {
        entries.push({ key: storageProgramKey(storageAddress), valueHash: leaf })
    }
    return SparseMerkleTree.build(entries).rootHex
}

interface Computed {
    root: string
    /** Leaves computed here for rows that had none. */
    filled: StoredLeaf[]
    /** Set when the from-scratch rebuild ran. */
    scratch?: { root: string; differing: string[] }
}

async function compute(
    snapshot: StorageRootSnapshot,
    fromScratch: boolean,
): Promise<Computed> {
    const stored = await snapshot.leaves()
    const missing = stored.filter(row => !isStoredLeaf(row.smtLeaf))
    const computed = await leavesFromRows(
        snapshot,
        missing.map(row => row.storageAddress),
    )
    const leaves = new Map<string, string>()
    const filled: StoredLeaf[] = []
    for (const row of stored) {
        if (isStoredLeaf(row.smtLeaf)) {
            leaves.set(row.storageAddress, row.smtLeaf)
            continue
        }
        const leaf = computed.get(row.storageAddress) as string
        leaves.set(row.storageAddress, leaf)
        filled.push({ ...row, smtLeaf: leaf })
    }
    const result: Computed = { root: rootOf(leaves), filled }
    if (fromScratch) {
        const all = await leavesFromRows(snapshot, stored.map(row => row.storageAddress))
        result.scratch = {
            root: rootOf(all),
            differing: stored
                .map(row => row.storageAddress)
                .filter(address => all.get(address) !== leaves.get(address)),
        }
    }
    return result
}

/**
 * Cached root over one reader. The epoch is bumped when a write to the table
 * is issued and again once it commits: a root computed while a write was in
 * flight is cached under the epoch read before it started, so it is never
 * served after that write.
 */
export class StorageProgramsRoot {
    private epoch = 0
    private cached: { epoch: number; root: string } | null = null
    /** Times the root was rebuilt from the table. */
    builds = 0

    constructor(
        private readonly reader: StorageRootReader,
        private readonly recomputeFromScratch: () => boolean = () => false,
    ) {}

    markDirty(): void {
        this.epoch++
    }

    async root(): Promise<string> {
        const epoch = this.epoch
        const cached = this.cached?.epoch === epoch ? this.cached.root : null
        const fromScratch = this.recomputeFromScratch()
        if (cached !== null && !fromScratch) return cached

        this.builds++
        const result = await this.reader.read(snapshot => compute(snapshot, fromScratch))
        let root = result.root
        if (result.scratch) {
            if (cached !== null && cached !== result.root) {
                log.error(
                    `[storageRoot] cached root ${cached} is stale: the table gives ${result.root}; a write did not mark the cache dirty`,
                )
            }
            if (result.scratch.root !== result.root || result.scratch.differing.length > 0) {
                log.error(
                    `[storageRoot] stored leaves give ${result.root}, rows give ${result.scratch.root}; ` +
                        `${result.scratch.differing.length} leaf(s) differ, first ${result.scratch.differing.slice(0, 5).join(", ")}`,
                )
            }
            root = result.scratch.root
        }

        if (result.filled.length > 0) {
            try {
                await this.reader.fillLeaves(result.filled)
            } catch (error) {
                // Only a cache of what the rows already determine: the next
                // rebuild computes the same leaves again.
                log.warning(
                    `[storageRoot] could not store ${result.filled.length} computed leaf(s): ${error instanceof Error ? error.message : String(error)}`,
                )
            }
        }
        this.cached = { epoch, root: result.root }
        return root
    }
}

const databaseReader: StorageRootReader = {
    async read(work) {
        const dataSource = (await Datasource.getInstance()).getDataSource()
        return await dataSource.transaction("REPEATABLE READ", async (em: EntityManager) =>
            work({
                leaves: async () => {
                    const rows: { storageAddress: string; smtLeaf: string | null; version: string }[] =
                        await em.query(
                            `SELECT "storageAddress", "smtLeaf", xmin::text AS "version"
                             FROM "gcr_storageprogram" ORDER BY "storageAddress"`,
                        )
                    return rows
                },
                rows: addresses =>
                    em.getRepository(GCRStorageProgram).find({
                        where: { storageAddress: In(addresses) },
                    }),
            }),
        )
    },
    async fillLeaves(leaves) {
        const dataSource = (await Datasource.getInstance()).getDataSource()
        for (let i = 0; i < leaves.length; i += ROW_BATCH) {
            const batch = leaves.slice(i, i + ROW_BATCH)
            await dataSource.query(
                `UPDATE "gcr_storageprogram" AS sp SET "smtLeaf" = v.leaf
                 FROM unnest($1::text[], $2::text[], $3::text[]) AS v(address, leaf, version)
                 WHERE sp."storageAddress" = v.address AND sp.xmin::text = v.version`,
                [
                    batch.map(leaf => leaf.storageAddress),
                    batch.map(leaf => leaf.smtLeaf),
                    batch.map(leaf => leaf.version),
                ],
            )
        }
    },
}

const storageRoot = new StorageProgramsRoot(
    databaseReader,
    () => Config.getInstance().debug.storageRootRecompute,
)

/** Root of the committed storage-program table, lowercase hex. */
export function storageProgramsRoot(): Promise<string> {
    return storageRoot.root()
}

/** Call when a write to `gcr_storageprogram` is issued and once it commits. */
export function markStorageProgramsDirty(): void {
    storageRoot.markDirty()
}
