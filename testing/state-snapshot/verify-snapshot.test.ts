/**
 * P4-T2 — Unit tests for src/libs/blockchain/genesis/verifySnapshot.ts
 *
 * Exercises the full verify pipeline against temporary fixture directories
 * created inline (no real 213MB dump). Each test gets its own isolated
 * tempdir and cleans up in afterEach.
 *
 * Also exercises the `loadSnapshot` sentinel path for missing manifest /
 * missing dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"

import { verifySnapshot } from "../../src/libs/blockchain/genesis/verifySnapshot"
import { loadSnapshot } from "../../src/libs/blockchain/genesis/loadSnapshot"

// =============================================================================
// Fixture helpers
// =============================================================================

type GcrMainRow = {
    pubkey: string
    assignedTxs: string[]
    nonce: number
    balance: string
    identities: Record<string, unknown>
    points: Record<string, unknown>
    referralInfo: Record<string, unknown>
    flagged: boolean
    flaggedReason: string
    reviewed: boolean
    createdAt: string
    updatedAt: string
}

type StorageRow = {
    storageAddress: string
    owner: string
    programName: string
    encoding: string
    data: Record<string, unknown> | null
    sizeBytes: number
    acl: Record<string, unknown>
    metadata: Record<string, unknown> | null
    storageLocation: string
    ipfsCid: string | null
    salt: string | null
    createdByTx: string
    lastModifiedByTx: string
    totalFeesPaid: string
    isDeleted: boolean
    interactionTxs: string
    deletedByTx: string | null
    createdAt: string
    updatedAt: string
}

function makeGcrMainRow(overrides: Partial<GcrMainRow> = {}): GcrMainRow {
    return {
        pubkey: "0xaabb",
        assignedTxs: [],
        nonce: 0,
        balance: "1000000000000000000",
        identities: {},
        points: {},
        referralInfo: {},
        flagged: false,
        flaggedReason: "",
        reviewed: false,
        createdAt: "2025-08-04 11:10:47.903",
        updatedAt: "2025-08-04 11:10:47.903",
        ...overrides,
    }
}

function makeStorageRow(overrides: Partial<StorageRow> = {}): StorageRow {
    return {
        storageAddress: "stor-abc",
        owner: "0xowner",
        programName: "test-prog",
        encoding: "json",
        data: { key: "value" },
        sizeBytes: 100,
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
        ...overrides,
    }
}

function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex")
}

type FixtureOptions = {
    gcrMainRows?: GcrMainRow[]
    storageRows?: StorageRow[]
    identityRowsJsonl?: string
    manifestOverrides?: Record<string, unknown>
    skipManifest?: boolean
    skipGcrMain?: boolean
    skipStorage?: boolean
    skipIdentity?: boolean
}

/**
 * Write a fixture snapshot directory to `dir` and return the computed
 * sha256 values so tests can refer to them.
 */
async function writeFixture(
    dir: string,
    opts: FixtureOptions = {},
): Promise<{
    gcrMainSha: string
    storageSha: string
    identitySha: string
    balanceSum: bigint
    sizeBytesSum: number
}> {
    const gcrRows = opts.gcrMainRows ?? [makeGcrMainRow()]
    const storageRows = opts.storageRows ?? [makeStorageRow()]
    const identityContent = opts.identityRowsJsonl ?? ""

    const gcrMainContent = gcrRows.map(r => JSON.stringify(r)).join("\n") + (gcrRows.length > 0 ? "\n" : "")
    const storageContent = storageRows.map(r => JSON.stringify(r)).join("\n") + (storageRows.length > 0 ? "\n" : "")
    const identityBody = identityContent

    const gcrMainSha = sha256(gcrMainContent)
    const storageSha = sha256(storageContent)
    const identitySha = sha256(identityBody)

    const balanceSum = gcrRows.reduce((acc, r) => acc + BigInt(r.balance), 0n)
    const sizeBytesSum = storageRows.reduce((acc, r) => acc + r.sizeBytes, 0)

    const identityLineCount = identityBody
        .split("\n")
        .filter(l => l.length > 0).length

    const manifest = {
        schemaVersion: 1,
        source: {
            host: "test-host",
            chain_block_height: 0,
            chain_block_hash: "0x00",
            node_version: "test",
            pg_version: "17.0",
            dumped_at: "2026-01-01T00:00:00Z",
        },
        files: {
            "gcr_main.jsonl": {
                sha256: gcrMainSha,
                rows: gcrRows.length,
                balance_sum: balanceSum.toString(),
            },
            "gcr_storageprogram.jsonl": {
                sha256: storageSha,
                rows: storageRows.length,
                size_bytes_sum: sizeBytesSum,
            },
            "identity_commitments.jsonl": {
                sha256: identitySha,
                rows: identityLineCount,
            },
        },
        transforms_applied: {
            nonces_reset_to_zero: true,
            assigned_txs_emptied: true,
            test_identity_commitments_dropped: 0,
        },
        ...(opts.manifestOverrides ?? {}),
    }

    await mkdir(dir, { recursive: true })

    if (!opts.skipManifest) {
        await writeFile(
            join(dir, "manifest.json"),
            JSON.stringify(manifest, null, 2) + "\n",
        )
    }
    if (!opts.skipGcrMain) {
        await writeFile(join(dir, "gcr_main.jsonl"), gcrMainContent)
    }
    if (!opts.skipStorage) {
        await writeFile(join(dir, "gcr_storageprogram.jsonl"), storageContent)
    }
    if (!opts.skipIdentity) {
        await writeFile(join(dir, "identity_commitments.jsonl"), identityBody)
    }

    return { gcrMainSha, storageSha, identitySha, balanceSum, sizeBytesSum }
}

// =============================================================================
// Test setup
// =============================================================================

let snapshotDir: string

beforeEach(() => {
    snapshotDir = join(tmpdir(), `test-snapshot-${randomUUID()}`)
})

afterEach(async () => {
    // Best-effort cleanup; ignore errors if dir was never created.
    await rm(snapshotDir, { recursive: true, force: true })
})

// =============================================================================
// Tests: verifySnapshot
// =============================================================================

describe("verifySnapshot — happy path", () => {
    it("3-row gcr_main + 1-row storage + 0-row identity → returns manifest", async () => {
        const rows = [
            makeGcrMainRow({ pubkey: "0xa1", balance: "100" }),
            makeGcrMainRow({ pubkey: "0xa2", balance: "200" }),
            makeGcrMainRow({ pubkey: "0xa3", balance: "300" }),
        ]
        const { balanceSum } = await writeFixture(snapshotDir, {
            gcrMainRows: rows,
            storageRows: [makeStorageRow({ sizeBytes: 50 })],
            identityRowsJsonl: "",
        })

        const manifest = await verifySnapshot(snapshotDir)

        expect(manifest.schemaVersion).toBe(1)
        expect(manifest.files["gcr_main.jsonl"].rows).toBe(3)
        expect(manifest.files["gcr_main.jsonl"].balance_sum).toBe(
            balanceSum.toString(),
        )
        expect(manifest.files["gcr_storageprogram.jsonl"].rows).toBe(1)
        expect(manifest.files["identity_commitments.jsonl"].rows).toBe(0)
    })

    it("returns the manifest object with correct source metadata", async () => {
        await writeFixture(snapshotDir, { gcrMainRows: [] })
        const manifest = await verifySnapshot(snapshotDir)
        expect(manifest.source.host).toBe("test-host")
    })
})

describe("verifySnapshot — sha256 mismatch", () => {
    it("tampered gcr_main.jsonl causes throw with 'sha256 mismatch'", async () => {
        await writeFixture(snapshotDir, {
            gcrMainRows: [makeGcrMainRow({ pubkey: "0xok", balance: "100" })],
        })

        // Tamper the file: append a space to break the hash
        const gcrPath = join(snapshotDir, "gcr_main.jsonl")
        const existing = await Bun.file(gcrPath).text()
        await writeFile(gcrPath, existing + " ")

        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(/sha256 mismatch/)
    })

    it("tampered gcr_storageprogram.jsonl causes throw with 'sha256 mismatch'", async () => {
        await writeFixture(snapshotDir, {})

        const path = join(snapshotDir, "gcr_storageprogram.jsonl")
        const existing = await Bun.file(path).text()
        await writeFile(path, existing + "X")

        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(/sha256 mismatch/)
    })
})

describe("verifySnapshot — row count drift", () => {
    it("manifest says 3 rows but file has 4 → throws", async () => {
        const rows = [
            makeGcrMainRow({ pubkey: "0x01", balance: "100" }),
            makeGcrMainRow({ pubkey: "0x02", balance: "200" }),
            makeGcrMainRow({ pubkey: "0x03", balance: "300" }),
        ]
        await writeFixture(snapshotDir, { gcrMainRows: rows })

        // Add a 4th row to the file WITHOUT updating the manifest
        const gcrPath = join(snapshotDir, "gcr_main.jsonl")
        const extra = JSON.stringify(makeGcrMainRow({ pubkey: "0x04", balance: "400" }))
        const existing = await Bun.file(gcrPath).text()
        // Must recalculate SHA too — we fake only row count mismatch by
        // writing a 4th row and patching the manifest sha to match but
        // leaving rows=3.
        const newContent = existing + extra + "\n"
        const newSha = sha256(newContent)
        await writeFile(gcrPath, newContent)

        // Patch manifest to have correct sha (so sha check passes) but wrong row count
        const manifestPath = join(snapshotDir, "manifest.json")
        const manifestRaw = await Bun.file(manifestPath).text()
        const manifest = JSON.parse(manifestRaw)
        manifest.files["gcr_main.jsonl"].sha256 = newSha
        // rows stays 3 but actual file has 4
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(/row count mismatch/)
    })
})

describe("verifySnapshot — balance sum drift", () => {
    it("manifest declares wrong balance_sum → throws", async () => {
        await writeFixture(snapshotDir, {
            gcrMainRows: [makeGcrMainRow({ pubkey: "0xb1", balance: "1000" })],
            manifestOverrides: {
                files: {
                    "gcr_main.jsonl": {
                        sha256: sha256(
                            JSON.stringify(makeGcrMainRow({ pubkey: "0xb1", balance: "1000" })) + "\n",
                        ),
                        rows: 1,
                        balance_sum: "9999999", // deliberately wrong
                    },
                    "gcr_storageprogram.jsonl": {
                        sha256: sha256(
                            JSON.stringify(makeStorageRow()) + "\n",
                        ),
                        rows: 1,
                        size_bytes_sum: 100,
                    },
                    "identity_commitments.jsonl": {
                        sha256: sha256(""),
                        rows: 0,
                    },
                },
            },
        })

        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(/balance_sum mismatch/)
    })
})

describe("verifySnapshot — missing JSONL file", () => {
    it("manifest references gcr_main.jsonl that does not exist → throws", async () => {
        await writeFixture(snapshotDir, { skipGcrMain: true })

        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(
            /snapshot file missing/,
        )
    })

    it("manifest references gcr_storageprogram.jsonl that does not exist → throws", async () => {
        await writeFixture(snapshotDir, { skipStorage: true })

        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(
            /snapshot file missing/,
        )
    })
})

describe("verifySnapshot — missing manifest", () => {
    it("dir without manifest.json → verifySnapshot throws (cannot read manifest)", async () => {
        await mkdir(snapshotDir, { recursive: true })
        // Write the JSONL files but NOT the manifest
        await writeFile(join(snapshotDir, "gcr_main.jsonl"), "")
        await writeFile(join(snapshotDir, "gcr_storageprogram.jsonl"), "")
        await writeFile(join(snapshotDir, "identity_commitments.jsonl"), "")

        // verifySnapshot itself throws when manifest is missing
        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(/cannot read manifest/)
    })
})

// =============================================================================
// Tests: loadSnapshot (sentinel path)
// =============================================================================

describe("loadSnapshot — missing directory → available:false", () => {
    it("DEMOS_SNAPSHOT_DIR pointing to nonexistent dir → returns {available:false}", async () => {
        const nonExistent = join(tmpdir(), `no-such-dir-${randomUUID()}`)
        const prevEnv = process.env.DEMOS_SNAPSHOT_DIR
        try {
            process.env.DEMOS_SNAPSHOT_DIR = nonExistent
            const result = await loadSnapshot()
            expect(result.available).toBe(false)
        } finally {
            if (prevEnv === undefined) {
                delete process.env.DEMOS_SNAPSHOT_DIR
            } else {
                process.env.DEMOS_SNAPSHOT_DIR = prevEnv
            }
        }
    })

    it("DEMOS_SNAPSHOT_DIR pointing to dir with no manifest.json → returns {available:false}", async () => {
        await mkdir(snapshotDir, { recursive: true })
        // Dir exists but no manifest.json
        const prevEnv = process.env.DEMOS_SNAPSHOT_DIR
        try {
            process.env.DEMOS_SNAPSHOT_DIR = snapshotDir
            const result = await loadSnapshot()
            expect(result.available).toBe(false)
        } finally {
            if (prevEnv === undefined) {
                delete process.env.DEMOS_SNAPSHOT_DIR
            } else {
                process.env.DEMOS_SNAPSHOT_DIR = prevEnv
            }
        }
    })
})

// =============================================================================
// Tests: schemaVersion 2 (validators.jsonl + fork_state in manifest)
// =============================================================================

type ValidatorRow = {
    address: string
    status: string | null
    connection_url: string | null
    staked_amount: string
    first_seen: number | null
    valid_at: number | null
    unstake_requested_at: number | null
    unstake_available_at: number | null
}

function makeValidatorRow(overrides: Partial<ValidatorRow> = {}): ValidatorRow {
    return {
        address: "0xval1",
        status: "2",
        connection_url: "http://localhost",
        staked_amount: "1000000000",
        first_seen: 0,
        valid_at: 0,
        unstake_requested_at: null,
        unstake_available_at: null,
        ...overrides,
    }
}

type V2Options = {
    validators?: ValidatorRow[]
    forkState?: unknown[]
    omitValidatorsEntry?: boolean
    omitForkState?: boolean
    tamperValidators?: boolean
}

async function writeV2Fixture(dir: string, opts: V2Options = {}): Promise<void> {
    const gcr = [makeGcrMainRow({ pubkey: "0xv2", balance: "100" })]
    const storage = [makeStorageRow({ sizeBytes: 10 })]
    const validators = opts.validators ?? [makeValidatorRow()]

    const gcrContent = gcr.map(r => JSON.stringify(r)).join("\n") + "\n"
    const storageContent = storage.map(r => JSON.stringify(r)).join("\n") + "\n"
    const identityContent = ""
    const validatorsContent =
        validators.length > 0
            ? validators.map(r => JSON.stringify(r)).join("\n") + "\n"
            : ""

    const forkState = opts.omitForkState
        ? undefined
        : (opts.forkState ?? [
              {
                  fork_name: "osDenomination",
                  applied: true,
                  applied_at_block: "0",
                  applied_at: null,
                  pre_sum_dem: "100",
                  post_sum_os: "100000000000",
                  gcr_v2_row_count: 1,
                  legacy_row_count: 0,
                  validators_row_count: 1,
                  capped_count: 0,
                  total_value_lost_os: "0",
                  malformed_validators_count: 0,
              },
          ])

    const files: Record<string, unknown> = {
        "gcr_main.jsonl": {
            sha256: sha256(gcrContent),
            rows: gcr.length,
            balance_sum: gcr
                .reduce((a, r) => a + BigInt(r.balance), 0n)
                .toString(),
        },
        "gcr_storageprogram.jsonl": {
            sha256: sha256(storageContent),
            rows: storage.length,
            size_bytes_sum: storage.reduce((a, r) => a + r.sizeBytes, 0),
        },
        "identity_commitments.jsonl": {
            sha256: sha256(identityContent),
            rows: 0,
        },
    }
    if (!opts.omitValidatorsEntry) {
        files["validators.jsonl"] = {
            sha256: sha256(validatorsContent),
            rows: validators.length,
        }
    }

    const manifest = {
        schemaVersion: 2,
        source: {
            host: "test-host",
            chain_block_height: 0,
            chain_block_hash: "0x00",
            node_version: "test",
            pg_version: "16.0",
            dumped_at: "2026-01-01T00:00:00Z",
        },
        files,
        fork_state: forkState,
        transforms_applied: {
            nonces_reset_to_zero: true,
            assigned_txs_emptied: true,
            test_identity_commitments_dropped: 0,
        },
    }

    await mkdir(dir, { recursive: true })
    await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
    )
    await writeFile(join(dir, "gcr_main.jsonl"), gcrContent)
    await writeFile(join(dir, "gcr_storageprogram.jsonl"), storageContent)
    await writeFile(join(dir, "identity_commitments.jsonl"), identityContent)
    await writeFile(
        join(dir, "validators.jsonl"),
        opts.tamperValidators ? validatorsContent + "X" : validatorsContent,
    )
}

describe("verifySnapshot — schemaVersion 2", () => {
    it("valid v2 snapshot verifies and exposes validators + fork_state", async () => {
        await writeV2Fixture(snapshotDir)
        const manifest = await verifySnapshot(snapshotDir)
        expect(manifest.schemaVersion).toBe(2)
        expect(manifest.files["validators.jsonl"]?.rows).toBe(1)
        expect(manifest.fork_state).toHaveLength(1)
        expect(manifest.fork_state?.[0].fork_name).toBe("osDenomination")
        expect(manifest.fork_state?.[0].applied).toBe(true)
    })

    it("v2 missing validators.jsonl entry → throws", async () => {
        await writeV2Fixture(snapshotDir, { omitValidatorsEntry: true })
        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(
            /validators\.jsonl"\] missing/,
        )
    })

    it("v2 missing fork_state → throws", async () => {
        await writeV2Fixture(snapshotDir, { omitForkState: true })
        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(
            /fork_state must be an array/,
        )
    })

    it("v2 tampered validators.jsonl → sha256 mismatch", async () => {
        await writeV2Fixture(snapshotDir, { tamperValidators: true })
        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(
            /validators\.jsonl: sha256 mismatch/,
        )
    })

    it("v2 fork_state entry missing required fields → throws", async () => {
        await writeV2Fixture(snapshotDir, {
            forkState: [{ applied: true }],
        })
        await expect(verifySnapshot(snapshotDir)).rejects.toThrow(
            /fork_state entries require string fork_name/,
        )
    })
})

describe("loadSnapshot — validators stream", () => {
    async function withSnapshotDir<T>(fn: () => Promise<T>): Promise<T> {
        const prevEnv = process.env.DEMOS_SNAPSHOT_DIR
        try {
            process.env.DEMOS_SNAPSHOT_DIR = snapshotDir
            return await fn()
        } finally {
            if (prevEnv === undefined) delete process.env.DEMOS_SNAPSHOT_DIR
            else process.env.DEMOS_SNAPSHOT_DIR = prevEnv
        }
    }

    it("v2 fixture streams validator rows", async () => {
        await writeV2Fixture(snapshotDir, {
            validators: [
                makeValidatorRow({ address: "0xvalA" }),
                makeValidatorRow({ address: "0xvalB", status: null }),
            ],
        })
        await withSnapshotDir(async () => {
            const loader = await loadSnapshot()
            expect(loader.available).toBe(true)
            if (!loader.available) return
            const collected: string[] = []
            for await (const v of loader.streamValidators()) {
                collected.push(v.address)
            }
            expect(collected).toEqual(["0xvalA", "0xvalB"])
        })
    })

    it("v1 fixture (no validators.jsonl) → streamValidators yields nothing", async () => {
        await writeFixture(snapshotDir, { gcrMainRows: [] })
        await withSnapshotDir(async () => {
            const loader = await loadSnapshot()
            expect(loader.available).toBe(true)
            if (!loader.available) return
            const collected: string[] = []
            for await (const v of loader.streamValidators()) {
                collected.push(v.address)
            }
            expect(collected).toHaveLength(0)
        })
    })
})

describe("loadSnapshot — valid fixture → available:true with streaming", () => {
    it("streams gcr_main rows correctly", async () => {
        const rows = [
            makeGcrMainRow({ pubkey: "0xstream1", balance: "500" }),
            makeGcrMainRow({ pubkey: "0xstream2", balance: "1500" }),
        ]
        await writeFixture(snapshotDir, {
            gcrMainRows: rows,
            storageRows: [],
            identityRowsJsonl: "",
            // override storage sum to match empty
            manifestOverrides: {
                files: {
                    "gcr_main.jsonl": {
                        sha256: sha256(
                            rows.map(r => JSON.stringify(r)).join("\n") + "\n",
                        ),
                        rows: 2,
                        balance_sum: "2000",
                    },
                    "gcr_storageprogram.jsonl": {
                        sha256: sha256(""),
                        rows: 0,
                        size_bytes_sum: 0,
                    },
                    "identity_commitments.jsonl": {
                        sha256: sha256(""),
                        rows: 0,
                    },
                },
            },
        })

        const prevEnv = process.env.DEMOS_SNAPSHOT_DIR
        try {
            process.env.DEMOS_SNAPSHOT_DIR = snapshotDir
            const loader = await loadSnapshot()
            expect(loader.available).toBe(true)
            if (!loader.available) return

            const collected: Array<{ pubkey: string }> = []
            for await (const row of loader.streamGcrMain()) {
                collected.push({ pubkey: row.pubkey })
            }
            expect(collected).toHaveLength(2)
            expect(collected[0].pubkey).toBe("0xstream1")
            expect(collected[1].pubkey).toBe("0xstream2")
        } finally {
            if (prevEnv === undefined) {
                delete process.env.DEMOS_SNAPSHOT_DIR
            } else {
                process.env.DEMOS_SNAPSHOT_DIR = prevEnv
            }
        }
    })
})
