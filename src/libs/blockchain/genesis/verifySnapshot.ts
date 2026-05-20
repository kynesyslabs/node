/**
 * Shared snapshot verification logic.
 *
 * Single source of truth for the integrity checks performed against
 * `data/snapshot/manifest.json` + the three JSONL files. Used by both:
 *   - the CLI script `scripts/state-snapshot/verify-snapshot.ts`
 *     (operator-facing pre-flight)
 *   - the genesis loader `src/libs/blockchain/genesis/loadSnapshot.ts`
 *     (runtime integrity gate before any DB write)
 *
 * All failures throw with operator-facing messages.
 */

import { readFile, stat } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

export type SnapshotFileEntry = {
    sha256: string
    rows: number
    balance_sum?: string
    size_bytes_sum?: number
}

export type SnapshotManifest = {
    schemaVersion: number
    source: {
        host: string
        chain_block_height: number
        chain_block_hash: string
        node_version: string
        pg_version: string
        dumped_at: string
    }
    files: {
        "gcr_main.jsonl": SnapshotFileEntry & { balance_sum: string }
        "gcr_storageprogram.jsonl": SnapshotFileEntry & { size_bytes_sum: number }
        "identity_commitments.jsonl": SnapshotFileEntry
    }
    transforms_applied: {
        nonces_reset_to_zero: boolean
        assigned_txs_emptied: boolean
        test_identity_commitments_dropped: boolean | number
    }
}

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === "object" && x !== null && !Array.isArray(x)
}

function parseManifest(raw: string): SnapshotManifest {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) throw new Error("manifest is not an object")
    if (parsed.schemaVersion !== 1) {
        throw new Error(`unsupported schemaVersion: ${String(parsed.schemaVersion)}`)
    }
    if (!isRecord(parsed.files)) throw new Error("manifest.files missing")
    if (!isRecord(parsed.source)) throw new Error("manifest.source missing")
    if (!isRecord(parsed.transforms_applied)) {
        throw new Error("manifest.transforms_applied missing")
    }
    for (const key of [
        "gcr_main.jsonl",
        "gcr_storageprogram.jsonl",
        "identity_commitments.jsonl",
    ] as const) {
        const entry = (parsed.files as Record<string, unknown>)[key]
        if (!isRecord(entry)) throw new Error(`manifest.files["${key}"] missing`)
        if (typeof entry.sha256 !== "string") {
            throw new Error(`manifest.files["${key}"].sha256 missing`)
        }
        if (typeof entry.rows !== "number") {
            throw new Error(`manifest.files["${key}"].rows missing`)
        }
    }
    return parsed as unknown as SnapshotManifest
}

type FileStats = {
    sha256: string
    rows: number
    balanceSum?: bigint
    sizeBytesSum?: number
    /** First parse/validation error encountered during the pass, if any. */
    parseError?: Error
}

/**
 * Single-pass file read: computes sha256, row count, and an optional
 * per-row sum (balance for gcr_main, sizeBytes for gcr_storageprogram)
 * in one streaming pass to avoid TOCTOU races from re-opening the file.
 *
 * Parse/validation errors during line accumulation are captured in
 * `parseError` rather than thrown immediately. The caller MUST verify
 * sha256 first — if sha256 mismatches, the parse error is irrelevant
 * (the file is tampered). Only surface `parseError` when sha256 matches.
 *
 * @param path      absolute path to the JSONL file
 * @param sumField  optional field name to accumulate a numeric sum over
 *                  each non-empty line ("balance" uses bigint arithmetic;
 *                  "sizeBytes" uses number arithmetic)
 */
async function readFileSinglePass(
    path: string,
    sumField?: "balance" | "sizeBytes",
): Promise<FileStats> {
    const hash = createHash("sha256")
    let rows = 0
    let balanceSum = 0n
    let sizeBytesSum = 0
    let parseError: Error | undefined

    // Accumulate raw bytes for sha256 while also splitting on newlines for
    // row counting and optional field accumulation. We keep a leftover
    // buffer for lines that span chunk boundaries.
    let leftover = ""

    const stream = createReadStream(path)
    for await (const chunk of stream) {
        const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
        hash.update(buf)

        if (sumField && !parseError) {
            // Process complete lines within this chunk.
            const text = leftover + buf.toString("utf8")
            const parts = text.split("\n")
            // Last element may be incomplete — carry it over to the next chunk.
            leftover = parts.pop() ?? ""
            for (const line of parts) {
                if (line.length === 0) continue
                rows++
                try {
                    const obj: unknown = JSON.parse(line)
                    if (!isRecord(obj)) {
                        parseError = new Error(`${path}: row ${rows} is not an object`)
                        break
                    }
                    if (sumField === "balance") {
                        const v = obj.balance
                        if (typeof v !== "string") {
                            parseError = new Error(
                                `${path}: row ${rows} missing string balance, got ${typeof v}`,
                            )
                            break
                        }
                        balanceSum += BigInt(v)
                    } else {
                        const v = obj.sizeBytes
                        if (typeof v !== "number" || !Number.isSafeInteger(v)) {
                            parseError = new Error(
                                `${path}: row ${rows} missing numeric sizeBytes`,
                            )
                            break
                        }
                        sizeBytesSum += v
                    }
                } catch (err) {
                    parseError = err instanceof Error ? err : new Error(String(err))
                    break
                }
            }
        }
    }

    if (sumField && !parseError) {
        // Flush any trailing content not terminated by a newline.
        if (leftover.length > 0) {
            rows++
            try {
                const obj: unknown = JSON.parse(leftover)
                if (!isRecord(obj)) {
                    parseError = new Error(`${path}: trailing row ${rows} is not an object`)
                } else if (sumField === "balance") {
                    const v = obj.balance
                    if (typeof v !== "string") {
                        parseError = new Error(
                            `${path}: trailing row ${rows} missing string balance`,
                        )
                    } else {
                        balanceSum += BigInt(v)
                    }
                } else {
                    const v = obj.sizeBytes
                    if (typeof v !== "number" || !Number.isSafeInteger(v)) {
                        parseError = new Error(
                            `${path}: trailing row ${rows} missing numeric sizeBytes`,
                        )
                    } else {
                        sizeBytesSum += v
                    }
                }
            } catch (err) {
                parseError = err instanceof Error ? err : new Error(String(err))
            }
        }
    }

    if (!sumField) {
        // No sum needed — count non-empty lines by scanning the buffered text.
        // For identity_commitments (0 bytes) this is effectively instantaneous.
        // We reuse the leftover buffer which holds any trailing partial line.
        // Since we already streamed the file for sha256, we do a second
        // cheap readFile for row counting (identity file is 0 bytes; this is free).
        const content = await readFile(path, "utf8")
        for (const line of content.split("\n")) {
            if (line.length > 0) rows++
        }
    }

    return {
        sha256: hash.digest("hex"),
        rows,
        ...(sumField === "balance" ? { balanceSum } : {}),
        ...(sumField === "sizeBytes" ? { sizeBytesSum } : {}),
        ...(parseError ? { parseError } : {}),
    }
}

/**
 * Verify a snapshot directory against its manifest. Throws with an
 * operator-facing message on any mismatch.
 *
 * @param snapshotDir absolute path to the directory containing
 *   `manifest.json` + the three `.jsonl` files.
 */
export async function verifySnapshot(
    snapshotDir: string,
): Promise<SnapshotManifest> {
    const manifestPath = resolve(snapshotDir, "manifest.json")
    let manifestRaw: string
    try {
        manifestRaw = await readFile(manifestPath, "utf8")
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`cannot read manifest at ${manifestPath}: ${msg}`)
    }

    const manifest = parseManifest(manifestRaw)

    // gcr_main: single pass for sha256 + row count + balance sum.
    const gcrMainPath = resolve(snapshotDir, "gcr_main.jsonl")
    try {
        await stat(gcrMainPath)
    } catch {
        throw new Error(`snapshot file missing: ${gcrMainPath}`)
    }
    const gcrMainStats = await readFileSinglePass(gcrMainPath, "balance")
    const gcrMainExpected = manifest.files["gcr_main.jsonl"]
    // Check sha256 first — a tampered file will fail here before any parse error surfaces.
    if (gcrMainStats.sha256 !== gcrMainExpected.sha256) {
        throw new Error(
            `gcr_main.jsonl: sha256 mismatch (got ${gcrMainStats.sha256}, expected ${gcrMainExpected.sha256})`,
        )
    }
    if (gcrMainStats.parseError) throw gcrMainStats.parseError
    if (gcrMainStats.rows !== gcrMainExpected.rows) {
        throw new Error(
            `gcr_main.jsonl: row count mismatch (got ${gcrMainStats.rows}, expected ${gcrMainExpected.rows})`,
        )
    }
    const expectedBalanceSum = BigInt(gcrMainExpected.balance_sum)
    if (gcrMainStats.balanceSum !== expectedBalanceSum) {
        throw new Error(
            `gcr_main.jsonl: balance_sum mismatch (got ${gcrMainStats.balanceSum}, expected ${expectedBalanceSum})`,
        )
    }

    // gcr_storageprogram: single pass for sha256 + row count + sizeBytes sum.
    const storagePath = resolve(snapshotDir, "gcr_storageprogram.jsonl")
    try {
        await stat(storagePath)
    } catch {
        throw new Error(`snapshot file missing: ${storagePath}`)
    }
    const storageStats = await readFileSinglePass(storagePath, "sizeBytes")
    const storageExpected = manifest.files["gcr_storageprogram.jsonl"]
    // Check sha256 first — a tampered file will fail here before any parse error surfaces.
    if (storageStats.sha256 !== storageExpected.sha256) {
        throw new Error(
            `gcr_storageprogram.jsonl: sha256 mismatch (got ${storageStats.sha256}, expected ${storageExpected.sha256})`,
        )
    }
    if (storageStats.parseError) throw storageStats.parseError
    if (storageStats.rows !== storageExpected.rows) {
        throw new Error(
            `gcr_storageprogram.jsonl: row count mismatch (got ${storageStats.rows}, expected ${storageExpected.rows})`,
        )
    }
    if (storageStats.sizeBytesSum !== storageExpected.size_bytes_sum) {
        throw new Error(
            `gcr_storageprogram.jsonl: size_bytes_sum mismatch (got ${storageStats.sizeBytesSum}, expected ${storageExpected.size_bytes_sum})`,
        )
    }

    // identity_commitments: single pass for sha256 + row count (no sum field).
    const identityPath = resolve(snapshotDir, "identity_commitments.jsonl")
    try {
        await stat(identityPath)
    } catch {
        throw new Error(`snapshot file missing: ${identityPath}`)
    }
    const identityStats = await readFileSinglePass(identityPath)
    const identityExpected = manifest.files["identity_commitments.jsonl"]
    if (identityStats.sha256 !== identityExpected.sha256) {
        throw new Error(
            `identity_commitments.jsonl: sha256 mismatch (got ${identityStats.sha256}, expected ${identityExpected.sha256})`,
        )
    }
    if (identityStats.rows !== identityExpected.rows) {
        throw new Error(
            `identity_commitments.jsonl: row count mismatch (got ${identityStats.rows}, expected ${identityExpected.rows})`,
        )
    }

    return manifest
}
