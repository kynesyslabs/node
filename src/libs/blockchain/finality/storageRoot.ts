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
import { SparseMerkleTree, type SparseTerminal } from "@/libs/crypto/merkle/sparse"
import Datasource from "@/model/datasource"
import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import log from "src/utilities/logger"
import {
    storageProgramKey,
    storageProgramLeafHex,
    storageProgramRecord,
    type StorageProgramRecord,
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

function treeOf(leaves: Iterable<[string, string]>): SparseMerkleTree {
    const entries = []
    for (const [storageAddress, leaf] of leaves) {
        entries.push({ key: storageProgramKey(storageAddress), valueHash: leaf })
    }
    return SparseMerkleTree.build(entries)
}

const rootOf = (leaves: Iterable<[string, string]>): string => treeOf(leaves).rootHex

interface Computed {
    root: string
    /** Leaves computed here for rows that had none. */
    filled: StoredLeaf[]
    /** Set when the from-scratch rebuild ran. */
    scratch?: { root: string; differing: string[] }
}

/** Every leaf of the snapshot: stored ones, and computed ones for rows without. */
async function currentLeaves(
    snapshot: StorageRootSnapshot,
): Promise<{ stored: StoredLeaf[]; leaves: Map<string, string>; filled: StoredLeaf[] }> {
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
    return { stored, leaves, filled }
}

async function compute(
    snapshot: StorageRootSnapshot,
    fromScratch: boolean,
): Promise<Computed> {
    const { stored, leaves, filled } = await currentLeaves(snapshot)
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

/** One program's place in the tree: its record when present, and the path to it. */
export interface StorageProgramProof {
    storageAddress: string
    record: StorageProgramRecord | null
    siblings: string[]
    terminal: SparseTerminal
}

export interface StorageProofSet {
    root: string
    proofs: StorageProgramProof[]
}

/** A built tree with the leaves it holds, by storage address. */
interface BuiltTree {
    leaves: Map<string, string>
    tree: SparseMerkleTree
}

/**
 * Proofs for `addresses` from one snapshot of the table, against the root of
 * that same snapshot, or of `built` when it is the tree of the same state. A
 * client rebuilds each leaf from the record served, so a stored leaf that no
 * longer matches its row is refused here instead of being served as a proof
 * that cannot verify.
 */
async function proveIn(
    snapshot: StorageRootSnapshot,
    addresses: string[],
    built: BuiltTree | null,
): Promise<{ set: StorageProofSet; built: BuiltTree }> {
    if (built === null) {
        const { leaves } = await currentLeaves(snapshot)
        built = { leaves, tree: treeOf(leaves) }
    }
    const { leaves, tree } = built
    const rows = new Map<string, StorageProgramRow>()
    for (const row of await snapshot.rows(addresses)) rows.set(row.storageAddress, row)

    const proofs = addresses.map(storageAddress => {
        const row = rows.get(storageAddress) ?? null
        const { siblings, terminal } = tree.prove(storageProgramKey(storageAddress))
        if (row !== null && storageProgramLeafHex(row) !== leaves.get(storageAddress)) {
            throw new Error(
                `storage proof: stored leaf of ${storageAddress} does not match its row`,
            )
        }
        return {
            storageAddress,
            record: row === null ? null : storageProgramRecord(row),
            siblings,
            terminal,
        }
    })
    return { set: { root: tree.rootHex, proofs }, built }
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
    // Kept for proofs only: a node that serves none never holds the tree.
    private proofTree: { epoch: number; built: BuiltTree } | null = null
    /** Times the root was rebuilt from the table. */
    builds = 0
    /** Times a proof read every leaf and built the tree. */
    proofTreeBuilds = 0

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

    /**
     * Proofs for `addresses` and the root they verify against, from one
     * snapshot. The tree is reused until a write marks the table dirty, by
     * the same epoch rule as the root.
     */
    async prove(addresses: string[]): Promise<StorageProofSet> {
        const epoch = this.epoch
        const reuse = this.proofTree?.epoch === epoch ? this.proofTree.built : null
        if (reuse === null) this.proofTreeBuilds++
        const { set, built } = await this.reader.read(snapshot =>
            proveIn(snapshot, addresses, reuse),
        )
        if (reuse === null) this.proofTree = { epoch, built }
        return set
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

/**
 * Proofs for `addresses` against the root of the committed table. The caller
 * holds the sync lock, so no block lands between the read and the anchor it
 * is checked against.
 */
export function proveStoragePrograms(addresses: string[]): Promise<StorageProofSet> {
    return storageRoot.prove(addresses)
}

/** Call when a write to `gcr_storageprogram` is issued and once it commits. */
export function markStorageProgramsDirty(): void {
    storageRoot.markDirty()
}
