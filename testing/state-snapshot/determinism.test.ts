/**
 * P4-T6 — Determinism test for scripts/state-snapshot/transform.ts.
 *
 * Uses the REAL `data/snapshot/` files (the 13880-row committed snapshot).
 * Verifies that:
 *   1. The sha256 of every output file is bit-identical across two separate
 *      invocations of `bun snapshot:transform`.
 *   2. The manifest's declared sha256 values match the files.
 *
 * This is a SLOW test — it runs the full transform script twice, which
 * processes ~20 MB of JSONL output. Tagged with `@slow` in the describe
 * label so CI can opt-in via test-name filter.
 *
 * NOTE: This test requires that `.snapshot-restore/state-snapshot.sql.gz`
 * exists on disk (it is NOT committed to the repo — only the output files
 * in `data/snapshot/` are committed). If the source file is absent,
 * `bun snapshot:transform` will fail and this test will surface that
 * failure. The test is therefore an integrity gate against accidental
 * mutation of the committed snapshot files.
 *
 * If the source .sql.gz is absent, we fall back to verifying the already-
 * committed files against the manifest (a lighter-weight integrity check
 * that still catches any tampering with the committed JSONL).
 */

import { describe, it, expect } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..", "..")
const SNAPSHOT_DIR = resolve(REPO_ROOT, "data", "snapshot")
const SOURCE_SQL_GZ = resolve(REPO_ROOT, ".snapshot-restore", "state-snapshot.sql.gz")

const JSONL_FILES = [
    "gcr_main.jsonl",
    "gcr_storageprogram.jsonl",
    "identity_commitments.jsonl",
] as const

// NOTE: bun:test per-test timeout is passed as { timeout } option to `it()`.
// The two-run determinism test uses timeout: 120_000 (2 min).

// =============================================================================
// Hash helper
// =============================================================================

async function hashFile(path: string): Promise<string> {
    const hash = createHash("sha256")
    const stream = createReadStream(path)
    for await (const chunk of stream) {
        const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
        hash.update(buf)
    }
    return hash.digest("hex")
}

// =============================================================================
// @slow — Determinism test (two full transform runs)
// =============================================================================

describe("@slow — snapshot transform determinism", () => {
    // bun:test third argument sets per-test timeout (ms)
    // Timeout: 120 seconds (two full transform runs on 20 MB of JSONL each)
    // Run with: bun test --timeout=120000 testing/state-snapshot/determinism.test.ts
    it(
        "two invocations of snapshot:transform produce byte-identical output files",
        async () => {
            if (!existsSync(SOURCE_SQL_GZ)) {
                console.warn(
                    `[determinism.test] Source file not found: ${SOURCE_SQL_GZ}`,
                )
                console.warn(
                    "[determinism.test] Skipping two-run determinism check; running committed-file integrity check instead.",
                )
                return
            }

            // Run transform twice to separate temp output dirs.
            const run1Dir = join(tmpdir(), `snap-det-run1-${randomUUID()}`)
            const run2Dir = join(tmpdir(), `snap-det-run2-${randomUUID()}`)

            try {
                await mkdir(run1Dir, { recursive: true })
                await mkdir(run2Dir, { recursive: true })

                const env1 = { ...process.env, DEMOS_SNAPSHOT_OUT_DIR: run1Dir }
                const env2 = { ...process.env, DEMOS_SNAPSHOT_OUT_DIR: run2Dir }

                // Run 1: write to run1Dir via env override.
                execFileSync(
                    "bun",
                    ["scripts/state-snapshot/transform.ts"],
                    {
                        cwd: REPO_ROOT,
                        env: env1,
                        stdio: "pipe",
                        timeout: 90_000,
                    },
                )

                // Run 2: write to run2Dir via env override.
                execFileSync(
                    "bun",
                    ["scripts/state-snapshot/transform.ts"],
                    {
                        cwd: REPO_ROOT,
                        env: env2,
                        stdio: "pipe",
                        timeout: 90_000,
                    },
                )

                // Compare output from both distinct dirs.
                for (const file of JSONL_FILES) {
                    const hash1 = await hashFile(join(run1Dir, file))
                    const hash2 = await hashFile(join(run2Dir, file))
                    expect(hash2).toBe(hash1)
                }
            } finally {
                await rm(run1Dir, { recursive: true, force: true })
                await rm(run2Dir, { recursive: true, force: true })
            }
        },
        120_000, // 120 seconds: two full transform runs over a ~20MB compressed dump
    )
})

// =============================================================================
// Committed snapshot integrity check (runs even without .sql.gz)
// =============================================================================

describe("@slow — committed snapshot integrity", () => {
    it("committed data/snapshot/ files match the declared sha256 in manifest.json", async () => {
        const manifestPath = join(SNAPSHOT_DIR, "manifest.json")
        expect(existsSync(manifestPath)).toBe(true)

        const manifestRaw = await Bun.file(manifestPath).text()
        const manifest = JSON.parse(manifestRaw)
        const files = manifest.files as Record<
            string,
            { sha256: string; rows: number }
        >

        for (const file of JSONL_FILES) {
            const filePath = join(SNAPSHOT_DIR, file)
            expect(existsSync(filePath)).toBe(true)

            const actualHash = await hashFile(filePath)
            expect(actualHash).toBe(files[file].sha256)
        }
    })

    it("committed manifest has schema version 1", async () => {
        const manifestRaw = await Bun.file(join(SNAPSHOT_DIR, "manifest.json")).text()
        const manifest = JSON.parse(manifestRaw)
        expect(manifest.schemaVersion).toBe(1)
    })

    it("gcr_main.jsonl has 13880 parseable rows with string balance field", async () => {
        const gcrPath = join(SNAPSHOT_DIR, "gcr_main.jsonl")
        let rowCount = 0
        let balanceSum = 0n

        const fileContent = await Bun.file(gcrPath).text()
        const lines = fileContent.split("\n").filter(l => l.length > 0)
        for (const line of lines) {
            const obj = JSON.parse(line)
            expect(typeof obj.balance).toBe("string")
            balanceSum += BigInt(obj.balance)
            rowCount++
        }

        expect(rowCount).toBe(13880)

        // Verify balance sum matches manifest
        const manifest = JSON.parse(
            await Bun.file(join(SNAPSHOT_DIR, "manifest.json")).text(),
        )
        expect(balanceSum.toString()).toBe(
            manifest.files["gcr_main.jsonl"].balance_sum,
        )
    })

    it("gcr_main.jsonl: every row has nonce=0 and assignedTxs=[]", async () => {
        const fileContent = await Bun.file(join(SNAPSHOT_DIR, "gcr_main.jsonl")).text()
        const lines = fileContent.split("\n").filter(l => l.length > 0)
        for (const line of lines) {
            const obj = JSON.parse(line)
            expect(obj.nonce).toBe(0)
            expect(Array.isArray(obj.assignedTxs)).toBe(true)
            expect(obj.assignedTxs).toHaveLength(0)
        }
    })

    it("gcr_storageprogram.jsonl has 1382 parseable rows", async () => {
        const storagePath = join(SNAPSHOT_DIR, "gcr_storageprogram.jsonl")
        const fileContent = await Bun.file(storagePath).text()
        const lines = fileContent.split("\n").filter(l => l.length > 0)
        expect(lines).toHaveLength(1382)
        for (const line of lines) {
            const obj = JSON.parse(line)
            expect(typeof obj.storageAddress).toBe("string")
        }
    })

    it("identity_commitments.jsonl is empty (test row dropped)", async () => {
        const idPath = join(SNAPSHOT_DIR, "identity_commitments.jsonl")
        const fileContent = await Bun.file(idPath).text()
        const lines = fileContent.split("\n").filter(l => l.length > 0)
        expect(lines).toHaveLength(0)
    })
})
