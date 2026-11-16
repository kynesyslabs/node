/**
 * Snapshot restore hashes each file as it is streamed into the genesis
 * transaction and compares the digest with the manifest `verifySnapshot`
 * checked. A file that changed after verification must roll the transaction
 * back, and an unchanged snapshot must restore as before.
 *
 * No database: the entity manager is an in-memory stand-in whose transaction
 * commits its staged rows only when the work resolves.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EntityManager } from "typeorm"

import { loadSnapshot } from "src/libs/blockchain/genesis/loadSnapshot"
import { restoreGenesisState, type GenesisStateSteps } from "src/libs/blockchain/genesis/restoreGenesisState"
import { restoreSnapshot } from "src/libs/blockchain/genesis/restoreSnapshot"

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex")

const GCR_PUBKEYS = ["0xpubkey01", "0xpubkey02", "0xpubkey03"]

function gcrMainJsonl(pubkeys: string[]): string {
    return pubkeys
        .map(pubkey =>
            JSON.stringify({
                pubkey,
                assignedTxs: [],
                nonce: 0,
                balance: "1000",
                identities: {},
                points: {},
                referralInfo: {},
                flagged: false,
                flaggedReason: "",
                reviewed: false,
                createdAt: "2025-08-04 11:10:47.903",
                updatedAt: "2025-08-04 11:10:47.903",
            }) + "\n",
        )
        .join("")
}

function storageJsonl(addresses: string[]): string {
    return addresses
        .map(storageAddress =>
            JSON.stringify({
                storageAddress,
                owner: "0xowner",
                programName: "prog",
                encoding: "json",
                data: { key: "v" },
                sizeBytes: 10,
                acl: { mode: "public" },
                metadata: null,
                storageLocation: "onchain",
                ipfsCid: null,
                salt: null,
                createdByTx: "0xtx",
                lastModifiedByTx: "0xtx",
                totalFeesPaid: "1",
                isDeleted: false,
                interactionTxs: "0xtx",
                deletedByTx: null,
                createdAt: "2026-01-01 00:00:00",
                updatedAt: "2026-01-01 00:00:00",
            }) + "\n",
        )
        .join("")
}

const STORAGE_ADDRESSES = ["stor-001", "stor-002"]
const FILES = {
    "gcr_main.jsonl": gcrMainJsonl(GCR_PUBKEYS),
    "gcr_storageprogram.jsonl": storageJsonl(STORAGE_ADDRESSES),
    "identity_commitments.jsonl": "",
}

async function writeSnapshot(dir: string): Promise<void> {
    const manifest = {
        schemaVersion: 1,
        source: {
            host: "test",
            chain_block_height: 0,
            chain_block_hash: "0x00",
            node_version: "test",
            pg_version: "17.0",
            dumped_at: "2026-01-01T00:00:00Z",
        },
        files: {
            "gcr_main.jsonl": {
                sha256: sha256(FILES["gcr_main.jsonl"]),
                rows: GCR_PUBKEYS.length,
                balance_sum: String(1000 * GCR_PUBKEYS.length),
            },
            "gcr_storageprogram.jsonl": {
                sha256: sha256(FILES["gcr_storageprogram.jsonl"]),
                rows: STORAGE_ADDRESSES.length,
                size_bytes_sum: 10 * STORAGE_ADDRESSES.length,
            },
            "identity_commitments.jsonl": { sha256: sha256(""), rows: 0 },
        },
        transforms_applied: {
            nonces_reset_to_zero: true,
            assigned_txs_emptied: true,
            test_identity_commitments_dropped: 0,
        },
    }
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
    for (const [name, content] of Object.entries(FILES)) {
        await writeFile(join(dir, name), content)
    }
}

type Staged = { table: string; rows: unknown[] }

/** An EntityManager that records inserts; the transaction keeps them only if the work resolves. */
function memoryDatabase() {
    const committed: Staged[] = []
    async function transaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
        const staged: Staged[] = []
        const em = Object.create(EntityManager.prototype) as EntityManager
        Object.assign(em, {
            connection: { getMetadata: () => ({ columns: new Array(10) }) },
            query: async () => [{ count: "0" }],
            insert: async (target: { name: string }, rows: unknown[]) => {
                staged.push({ table: target.name, rows: [...rows] })
            },
        })
        const result = await work(em)
        committed.push(...staged)
        return result
    }
    return { committed, transaction }
}

const noopStep = async () => undefined
const STEPS: GenesisStateSteps = {
    assertCarryover: noopStep as unknown as GenesisStateSteps["assertCarryover"],
    restore: restoreSnapshot,
    mergeBalances: noopStep as unknown as GenesisStateSteps["mergeBalances"],
    applyForks: noopStep as unknown as GenesisStateSteps["applyForks"],
    seedValidators: noopStep as unknown as GenesisStateSteps["seedValidators"],
}

const savedDir = process.env.DEMOS_SNAPSHOT_DIR
let dir: string

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "snapshot-hash-at-restore-"))
    await writeSnapshot(dir)
    process.env.DEMOS_SNAPSHOT_DIR = dir
})

afterEach(async () => {
    if (savedDir === undefined) delete process.env.DEMOS_SNAPSHOT_DIR
    else process.env.DEMOS_SNAPSHOT_DIR = savedDir
    await rm(dir, { recursive: true, force: true })
})

describe("restore hashes snapshot files as it reads them", () => {
    it("restores an unchanged snapshot as before", async () => {
        const db = memoryDatabase()
        const loader = await loadSnapshot()

        const restored = await restoreGenesisState(db.transaction, loader, {}, STEPS)

        expect(restored).toBe(true)
        const rowsOf = (table: string) => db.committed.filter(s => s.table === table).flatMap(s => s.rows)
        expect(rowsOf("GCRMain")).toHaveLength(GCR_PUBKEYS.length)
        expect(rowsOf("GCRStorageProgram")).toHaveLength(STORAGE_ADDRESSES.length)
    })

    it("rolls back when gcr_main.jsonl changes after verification", async () => {
        const db = memoryDatabase()
        const loader = await loadSnapshot()
        // Same row count and valid rows, different content
        const changed = gcrMainJsonl(["0xpubkey01", "0xpubkey02", "0xother"])
        await writeFile(join(dir, "gcr_main.jsonl"), changed)

        const failure = await restoreGenesisState(db.transaction, loader, {}, STEPS).catch(e => e as Error)

        expect(failure).toBeInstanceOf(Error)
        const message = (failure as Error).message
        expect(message).toContain("gcr_main.jsonl")
        expect(message).toContain(sha256(changed))
        expect(message).toContain(sha256(FILES["gcr_main.jsonl"]))
        expect(db.committed).toEqual([])
    })

    it("rolls back rows already staged when a later file changes after verification", async () => {
        const db = memoryDatabase()
        const loader = await loadSnapshot()
        const changed = storageJsonl(["stor-001", "stor-changed"])
        await writeFile(join(dir, "gcr_storageprogram.jsonl"), changed)

        const failure = await restoreGenesisState(db.transaction, loader, {}, STEPS).catch(e => e as Error)

        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain("gcr_storageprogram.jsonl")
        expect((failure as Error).message).toContain(sha256(changed))
        expect(db.committed).toEqual([])
    })

    it("rejects a file that grew after verification", async () => {
        const db = memoryDatabase()
        const loader = await loadSnapshot()
        await writeFile(join(dir, "identity_commitments.jsonl"), "\n\n")

        const failure = await restoreGenesisState(db.transaction, loader, {}, STEPS).catch(e => e as Error)

        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain("identity_commitments.jsonl")
        expect(db.committed).toEqual([])
    })
})
