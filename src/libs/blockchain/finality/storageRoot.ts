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
import { readStorageHistory, type StorageHistoryRow } from "./storageHistory"
import {
    storageProgramKey,
    storageProgramLeafHex,
    storageProgramRecord,
    storageRecordLeafHex,
    type StorageProgramRecord,
    type StorageProgramRow,
} from "./storageRecord"

export interface StoredLeaf {
    storageAddress: string
    smtLeaf: string | null
    /** Row version, so a filled-in leaf never lands on a row changed since. */
    version: string
}

/** One consistent view of the table and its undo log. */
export interface StorageRootSnapshot {
    leaves(): Promise<StoredLeaf[]>
    rows(addresses: string[]): Promise<StorageProgramRow[]>
    /** Undo-log rows of blocks `from`..`to`, newest block first. */
    history(from: number, to: number): Promise<StorageHistoryRow[]>
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

/** Blocks whose storage writes a proof undoes: `fromBlock`..`toBlock`. */
export interface StorageUndo {
    fromBlock: number
    toBlock: number
}

/** A built tree with the leaves it holds and the records undo put back, by storage address. */
interface BuiltTree {
    leaves: Map<string, string>
    undone: Map<string, StorageProgramRecord | null>
    tree: SparseMerkleTree
}

/**
 * Proofs for `addresses` from one snapshot of the table, against the root of
 * that same snapshot, or with `undo`, of the table as it stood before
 * `undo.fromBlock`; `built` is that tree when it is already held. A client
 * rebuilds each leaf from the record served, so a stored leaf that no longer
 * matches its row is refused here instead of being served as a proof that
 * cannot verify.
 */
async function proveIn(
    snapshot: StorageRootSnapshot,
    addresses: string[],
    undo: StorageUndo | undefined,
    built: BuiltTree | null,
): Promise<{ set: StorageProofSet; built: BuiltTree }> {
    if (built === null) {
        const { leaves } = await currentLeaves(snapshot)
        // Newest block first, so the record from before the oldest undone
        // block is the one left for each address.
        const undone = new Map<string, StorageProgramRecord | null>()
        if (undo) {
            for (const row of await snapshot.history(undo.fromBlock, undo.toBlock)) {
                undone.set(row.storageAddress, row.record)
            }
        }
        for (const [storageAddress, record] of undone) {
            if (record === null) leaves.delete(storageAddress)
            else leaves.set(storageAddress, storageRecordLeafHex(record))
        }
        built = { leaves, undone, tree: treeOf(leaves) }
    }
    const { leaves, undone, tree } = built
    const rows = new Map<string, StorageProgramRow>()
    const live = addresses.filter(address => !undone.has(address))
    for (const row of await snapshot.rows(live)) rows.set(row.storageAddress, row)

    const proofs = addresses.map(storageAddress => {
        const { siblings, terminal } = tree.prove(storageProgramKey(storageAddress))
        if (undone.has(storageAddress)) {
            return { storageAddress, record: undone.get(storageAddress), siblings, terminal }
        }
        const row = rows.get(storageAddress) ?? null
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

/** A proof needs a tree rebuild that the work cap does not allow yet. */
export class StorageProofBusyError extends Error {
    constructor(readonly retryAfterMs: number) {
        super("storage proof trees are being rebuilt; retry later")
        this.name = "StorageProofBusyError"
    }
}

/**
 * How much tree work proofs may cause. Proofs are anonymous reads and each
 * rebuild reads every leaf, so rebuilds are capped per window and run one
 * at a time; requests for a tree being built wait for it instead.
 */
export interface ProofTreeLimits {
    /** Trees kept by undo range; each holds every leaf. */
    trees: number
    buildsPerWindow: number
    windowMs: number
}

export const PROOF_TREE_LIMITS: ProofTreeLimits = { trees: 4, buildsPerWindow: 8, windowMs: 10_000 }

/**
 * Cached root over one reader. The epoch is bumped when a write to the table
 * is issued and again once it commits: a root computed while a write was in
 * flight is cached under the epoch read before it started, so it is never
 * served after that write.
 */
export class StorageProgramsRoot {
    private epoch = 0
    private cached: { epoch: number; root: string } | null = null
    // Kept for proofs only: a node that serves none never holds a tree.
    // Insertion order is recency order.
    private proofTrees = new Map<string, { epoch: number; built: BuiltTree }>()
    private pendingTree: { key: string; epoch: number; built: Promise<BuiltTree | null> } | null = null
    private treeBuildTimes: number[] = []
    /** Times the root was rebuilt from the table. */
    builds = 0
    /** Times a proof read every leaf and built the tree. */
    proofTreeBuilds = 0

    constructor(
        private readonly reader: StorageRootReader,
        private readonly recomputeFromScratch: () => boolean = () => false,
        private readonly limits: ProofTreeLimits = PROOF_TREE_LIMITS,
        private readonly now: () => number = Date.now,
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
     * snapshot. The tree for an undo range is reused until a write marks the
     * table dirty, by the same epoch rule as the root. With `expectedRoot`, a
     * tree giving another root is not kept: it came from a snapshot that does
     * not match the range.
     *
     * @throws StorageProofBusyError when a rebuild is needed and the work cap
     *   does not allow one now
     */
    async prove(
        addresses: string[],
        undo?: StorageUndo,
        expectedRoot?: string,
    ): Promise<StorageProofSet> {
        const epoch = this.epoch
        const key = undo ? `${undo.fromBlock}..${undo.toBlock}` : "live"
        let reuse = this.heldTree(key, epoch)
        const pending = this.pendingTree
        if (reuse === null && pending?.key === key && pending.epoch === epoch) {
            reuse = await pending.built
        }
        if (reuse !== null) {
            const { set } = await this.reader.read(snapshot =>
                proveIn(snapshot, addresses, undo, reuse),
            )
            return set
        }
        return await this.buildAndProve(addresses, undo, key, epoch, expectedRoot)
    }

    private async buildAndProve(
        addresses: string[],
        undo: StorageUndo | undefined,
        key: string,
        epoch: number,
        expectedRoot: string | undefined,
    ): Promise<StorageProofSet> {
        this.claimTreeBuild()
        this.proofTreeBuilds++
        let settle: (built: BuiltTree | null) => void = () => {}
        this.pendingTree = { key, epoch, built: new Promise(resolve => (settle = resolve)) }
        let kept: BuiltTree | null = null
        try {
            const { set, built } = await this.reader.read(snapshot =>
                proveIn(snapshot, addresses, undo, null),
            )
            if (expectedRoot === undefined || set.root === expectedRoot) {
                this.keepTree(key, epoch, built)
                kept = built
            }
            return set
        } finally {
            this.pendingTree = null
            settle(kept)
        }
    }

    private claimTreeBuild(): void {
        const now = this.now()
        if (this.pendingTree !== null) {
            throw new StorageProofBusyError(1_000)
        }
        const since = now - this.limits.windowMs
        this.treeBuildTimes = this.treeBuildTimes.filter(at => at > since)
        if (this.treeBuildTimes.length >= this.limits.buildsPerWindow) {
            throw new StorageProofBusyError(this.treeBuildTimes[0] + this.limits.windowMs - now)
        }
        this.treeBuildTimes.push(now)
    }

    private heldTree(key: string, epoch: number): BuiltTree | null {
        const held = this.proofTrees.get(key)
        if (!held) return null
        this.proofTrees.delete(key)
        if (held.epoch !== epoch) return null
        this.proofTrees.set(key, held)
        return held.built
    }

    private keepTree(key: string, epoch: number, built: BuiltTree): void {
        // A tree of an older epoch is never served again.
        for (const [heldKey, held] of this.proofTrees) {
            if (held.epoch !== this.epoch) this.proofTrees.delete(heldKey)
        }
        if (epoch !== this.epoch) return
        this.proofTrees.delete(key)
        this.proofTrees.set(key, { epoch, built })
        while (this.proofTrees.size > this.limits.trees) {
            const oldest = this.proofTrees.keys().next().value as string
            this.proofTrees.delete(oldest)
        }
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
                rows: async addresses =>
                    addresses.length === 0
                        ? []
                        : await em.getRepository(GCRStorageProgram).find({
                              where: { storageAddress: In(addresses) },
                          }),
                history: (from, to) => readStorageHistory(em, from, to),
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
 * Proofs for `addresses` against the root of the committed table, or with
 * `undo`, against the root of the table before `undo.fromBlock`, rebuilt by
 * undoing the logged writes of blocks `fromBlock`..`toBlock` (the head).
 * The trees of the last few ranges asked for are kept until a storage
 * write; a rebuild reads every leaf, about 60 ms for 10^4 programs, and is
 * capped by PROOF_TREE_LIMITS. The read is one snapshot and takes no lock,
 * so a block may land before it: the caller checks the root against
 * `expectedRoot`, the anchor's, and a tree that misses it is not kept.
 */
export function proveStoragePrograms(
    addresses: string[],
    undo?: StorageUndo,
    expectedRoot?: string,
): Promise<StorageProofSet> {
    return storageRoot.prove(addresses, undo, expectedRoot)
}

/** Call when a write to `gcr_storageprogram` is issued and once it commits. */
export function markStorageProgramsDirty(): void {
    storageRoot.markDirty()
}
