/**
 * The snapshot restore uses only the manifest.json bytes whose sha256 the
 * genesis declares (`snapshot.manifestSha256`). The boot check hashes the
 * manifest before block 0 is built; the restore hashes the manifest it parses
 * and refuses, before its transaction opens, when that hash is not the declared
 * one. A genesis that declares no manifest restores as before.
 *
 * No database: the entity manager is an in-memory stand-in whose transaction
 * commits its staged rows only when the work resolves.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EntityManager } from "typeorm"

// Block 0 creation without a database, for the call site in chainGenesis
const blockInserts: unknown[] = []
const dataSourceTransactions: unknown[] = []
mock.module("src/libs/blockchain/genesis/buildGenesisBlock", () => ({
    buildGenesisBlock: () => ({
        genesisBlock: { hash: "h0", content: { timestamp: 1_794_700_800 } },
        genesisTx: {},
    }),
}))
mock.module("src/libs/consensus/v2/routines/getCommonValidatorSeed", () => ({
    __esModule: true,
    default: async () => ({ commonValidatorSeed: "seed" }),
}))
const fakeDataSource = {
    transaction: async (work: unknown) => {
        dataSourceTransactions.push(work)
        throw new Error("no transaction expected")
    },
    getRepository: () => ({}),
}
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)
const realChainBlocks = { ...(await import("src/libs/blockchain/chainBlocks")) }
mock.module("src/libs/blockchain/chainBlocks", () => ({
    ...realChainBlocks,
    insertBlock: async (block: unknown) => {
        blockInserts.push(block)
    },
}))

const { loadSnapshot, snapshotManifestHash } = await import("src/libs/blockchain/genesis/loadSnapshot")
const { restoreGenesisState } = await import("src/libs/blockchain/genesis/restoreGenesisState")
type GenesisStateSteps = import("src/libs/blockchain/genesis/restoreGenesisState").GenesisStateSteps
const { restoreSnapshot } = await import("src/libs/blockchain/genesis/restoreSnapshot")
const { GenesisRefusal, freshGenesisProblems } = await import("src/libs/blockchain/genesis/genesisPin")
const { generateGenesisBlock } = await import("src/libs/blockchain/chainGenesis")

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex")

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

type Snapshot = { manifest: string; files: Record<string, string>; pubkeys: string[] }

/** A snapshot whose manifest matches its files, so verifySnapshot accepts it on its own. */
function snapshot(pubkeys: string[], addresses: string[]): Snapshot {
    const files = {
        "gcr_main.jsonl": gcrMainJsonl(pubkeys),
        "gcr_storageprogram.jsonl": storageJsonl(addresses),
        "identity_commitments.jsonl": "",
    }
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
                sha256: sha256(files["gcr_main.jsonl"]),
                rows: pubkeys.length,
                balance_sum: String(1000 * pubkeys.length),
            },
            "gcr_storageprogram.jsonl": {
                sha256: sha256(files["gcr_storageprogram.jsonl"]),
                rows: addresses.length,
                size_bytes_sum: 10 * addresses.length,
            },
            "identity_commitments.jsonl": { sha256: sha256(""), rows: 0 },
        },
        transforms_applied: {
            nonces_reset_to_zero: true,
            assigned_txs_emptied: true,
            test_identity_commitments_dropped: 0,
        },
    }
    return { manifest: JSON.stringify(manifest, null, 2), files, pubkeys }
}

const DECLARED = snapshot(["0xpubkey01", "0xpubkey02", "0xpubkey03"], ["stor-001", "stor-002"])
const OTHER = snapshot(["0xpubkey01", "0xpubkey02", "0xother", "0xother2"], ["stor-001"])

async function writeSnapshot(dir: string, s: Snapshot): Promise<void> {
    for (const [name, content] of Object.entries(s.files)) {
        await writeFile(join(dir, name), content)
    }
    await writeFile(join(dir, "manifest.json"), s.manifest)
}

function genesisDeclaring(s: Snapshot) {
    return { balances: [], snapshot: { manifestSha256: sha256(s.manifest) } }
}

/** The boot check findGenesisBlock runs on a fresh database, unpinned. */
async function bootCheck(genesisData: unknown): Promise<string[]> {
    return freshGenesisProblems({
        genesisData,
        pin: "",
        restore: false,
        snapshotManifestHash: await snapshotManifestHash(),
    })
}

type Staged = { table: string; rows: unknown[] }

/** An EntityManager that records inserts; the transaction keeps them only if the work resolves. */
function memoryDatabase() {
    const committed: Staged[] = []
    let opened = 0
    async function transaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
        opened++
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
    const rowsOf = (table: string) => committed.filter(s => s.table === table).flatMap(s => s.rows)
    return { committed, transaction, rowsOf, opened: () => opened }
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
    dir = await mkdtemp(join(tmpdir(), "snapshot-manifest-pin-"))
    await writeSnapshot(dir, DECLARED)
    process.env.DEMOS_SNAPSHOT_DIR = dir
    blockInserts.length = 0
    dataSourceTransactions.length = 0
})

afterEach(async () => {
    if (savedDir === undefined) delete process.env.DEMOS_SNAPSHOT_DIR
    else process.env.DEMOS_SNAPSHOT_DIR = savedDir
    await rm(dir, { recursive: true, force: true })
})

describe("snapshot restore uses only the manifest the genesis declares", () => {
    it("restores an untouched declared snapshot as before", async () => {
        const genesis = genesisDeclaring(DECLARED)
        expect(await bootCheck(genesis)).toEqual([])
        const db = memoryDatabase()
        const loader = await loadSnapshot()
        expect(loader.available).toBe(true)
        if (!loader.available) return
        // The hash of the bytes the restore parsed is the one the boot check computed
        expect(loader.manifestSha256).toBe(sha256(DECLARED.manifest))
        expect(loader.manifestSha256).toBe((await snapshotManifestHash()) as string)

        const restored = await restoreGenesisState(db.transaction, loader, genesis, STEPS)

        expect(restored).toBe(true)
        expect(db.rowsOf("GCRMain").map(r => (r as { pubkey: string }).pubkey)).toEqual(DECLARED.pubkeys)
        expect(db.rowsOf("GCRStorageProgram")).toHaveLength(2)
    })

    it("restores a snapshot when the genesis declares none, as before", async () => {
        const db = memoryDatabase()
        const loader = await loadSnapshot()

        const restored = await restoreGenesisState(db.transaction, loader, { balances: [] }, STEPS)

        expect(restored).toBe(true)
        expect(db.rowsOf("GCRMain")).toHaveLength(DECLARED.pubkeys.length)
    })

    it("refuses when manifest.json and its files change between the boot check and the restore", async () => {
        const genesis = genesisDeclaring(DECLARED)
        expect(await bootCheck(genesis)).toEqual([])
        await writeSnapshot(dir, OTHER)
        const db = memoryDatabase()
        // The changed snapshot is consistent with its own manifest
        const loader = await loadSnapshot()

        const failure = await restoreGenesisState(db.transaction, loader, genesis, STEPS).catch(e => e)

        expect(failure).toBeInstanceOf(GenesisRefusal)
        expect((failure as Error).message).toBe(
            `[GENESIS] Refusing to boot: snapshot manifest hashes to ${sha256(OTHER.manifest)}, ` +
                `genesis declares ${sha256(DECLARED.manifest)}`,
        )
        expect(db.opened()).toBe(0)
        expect(db.committed).toEqual([])
    })

    it("refuses when the declared manifest is gone at restore", async () => {
        const genesis = genesisDeclaring(DECLARED)
        expect(await bootCheck(genesis)).toEqual([])
        await rm(join(dir, "manifest.json"))
        const db = memoryDatabase()
        const loader = await loadSnapshot()
        expect(loader.available).toBe(false)

        const failure = await restoreGenesisState(db.transaction, loader, genesis, STEPS).catch(e => e)

        expect(failure).toBeInstanceOf(GenesisRefusal)
        expect((failure as Error).message).toContain(
            "genesis declares a snapshot but no snapshot manifest was found",
        )
        expect(db.opened()).toBe(0)
    })
})

describe("block 0 creation restores only the declared manifest", () => {
    it("stops before any write when the manifest changes after the boot check", async () => {
        const genesis = genesisDeclaring(DECLARED)
        expect(await bootCheck(genesis)).toEqual([])
        await writeSnapshot(dir, OTHER)

        const failure = await generateGenesisBlock(genesis).catch(e => e)

        expect(failure).toBeInstanceOf(GenesisRefusal)
        expect((failure as Error).message).toContain(`genesis declares ${sha256(DECLARED.manifest)}`)
        expect(dataSourceTransactions).toEqual([])
        expect(blockInserts).toEqual([])
    })
})
