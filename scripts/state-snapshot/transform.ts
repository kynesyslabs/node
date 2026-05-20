/**
 * State Snapshot Transformer (P0-T1).
 *
 * Reads `.snapshot-restore/state-snapshot.sql.gz` (a pg_dump --data-only
 * --column-inserts of `gcr_main`, `gcr_storageprogram`, `identity_commitments`)
 * and emits deterministic JSONL + manifest under `data/snapshot/`.
 *
 * Operator-locked transforms (per forking/restore/PLAN.md P0):
 *   - gcr_main.nonce              -> 0
 *   - gcr_main.assignedTxs        -> []
 *   - identity_commitments.*      -> drop test row (provider='test', leaf_index=-1)
 *   - createdAt / updatedAt       -> preserved verbatim
 *
 * Run: `bun scripts/state-snapshot/transform.ts`
 */

import { createReadStream } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { createGunzip } from "node:zlib"
import { createHash } from "node:crypto"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..", "..")
const SOURCE_PATH = resolve(REPO_ROOT, ".snapshot-restore", "state-snapshot.sql.gz")
const OUT_DIR = process.env.DEMOS_SNAPSHOT_OUT_DIR
    ? resolve(process.env.DEMOS_SNAPSHOT_OUT_DIR)
    : resolve(REPO_ROOT, "data", "snapshot")

// Hardcoded per task brief: approximate pg_dump time on node3.demos.sh.
// Hardcoded (not read from disk) so the manifest is byte-deterministic
// across runs / machines. See forking/restore/PLAN.md P0.
const DUMPED_AT_ISO = "2026-05-19T15:22:00Z"

// Source-of-truth values from anchor.txt / state-stats.txt.
// Re-asserted at the end of the transform to fail loud on any drift.
const EXPECTED_GCR_MAIN_ROWS = 13880
const EXPECTED_STORAGE_ROWS = 1382
const EXPECTED_BALANCE_SUM = 15024999999998868586n
const EXPECTED_SIZE_BYTES_SUM = 1269189
const EXPECTED_IDENTITY_COMMITMENT_DROPS = 1

const SOURCE_META = {
    host: "node3.demos.sh",
    chain_block_height: 2285755,
    chain_block_hash:
        "3c6a0b81e4cc8fdd44719f79f5f71938e75f465802f312c4fb475886a36b8338",
    node_version: "0.9.8",
    pg_version: "17.0",
    dumped_at: DUMPED_AT_ISO,
} as const

// Stable column order for each output table. The output JSONL keys appear
// in this order; deviation breaks the determinism contract.
export const GCR_MAIN_COLUMNS = [
    "pubkey",
    "assignedTxs",
    "nonce",
    "balance",
    "identities",
    "points",
    "referralInfo",
    "flagged",
    "flaggedReason",
    "reviewed",
    "createdAt",
    "updatedAt",
] as const

export const STORAGE_COLUMNS = [
    "storageAddress",
    "owner",
    "programName",
    "encoding",
    "data",
    "sizeBytes",
    "acl",
    "metadata",
    "storageLocation",
    "ipfsCid",
    "salt",
    "createdByTx",
    "lastModifiedByTx",
    "totalFeesPaid",
    "isDeleted",
    "interactionTxs",
    "deletedByTx",
    "createdAt",
    "updatedAt",
] as const

export const IDENTITY_COLUMNS = [
    "commitment_hash",
    "leaf_index",
    "provider",
    "block_number",
    "transaction_hash",
    "timestamp",
    "created_at",
] as const

type GcrMainCol = (typeof GCR_MAIN_COLUMNS)[number]
type StorageCol = (typeof STORAGE_COLUMNS)[number]
type IdentityCol = (typeof IDENTITY_COLUMNS)[number]

export type SqlValue =
    | { kind: "string"; value: string }
    | { kind: "number"; value: number }
    | { kind: "bigint"; value: bigint }
    | { kind: "bool"; value: boolean }
    | { kind: "null" }

/**
 * Parse a single `VALUES (...)` payload into tokens.
 *
 * The payload is the substring between the outer `(` and the matching `)`,
 * NOT including those parens. The tokenizer is a small hand-rolled state
 * machine because pg_dump's column-inserts format embeds jsonb-cast strings
 * with `''` escape sequences and JSON content containing commas / parens.
 *
 * Rules implemented:
 *   - Single-quoted strings: `'foo''bar'` -> string `foo'bar`. Two adjacent
 *     single quotes INSIDE a string literal collapse to one literal `'`.
 *   - `NULL` (case-insensitive) -> null token.
 *   - `true` / `false` (case-insensitive) -> bool token.
 *   - Numerics: optional sign, digits, optional decimal, no exponent in the
 *     dumps we have seen. Large integers go to bigint, anything fractional
 *     or fits-in-double goes to number.
 *   - Whitespace and commas between top-level tokens are skipped.
 *
 * Throws on any unexpected character; the caller annotates with line number.
 */
export function parseValuesPayload(payload: string): SqlValue[] {
    const tokens: SqlValue[] = []
    let i = 0
    const n = payload.length

    while (i < n) {
        const c = payload[i]
        if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
            i++
            continue
        }

        if (c === "'") {
            // Single-quoted string. Walk until the closing quote, handling
            // `''` as a literal embedded single quote.
            let out = ""
            let closed = false
            i++ // skip opening quote
            while (i < n) {
                const ch = payload[i]
                if (ch === "'") {
                    if (i + 1 < n && payload[i + 1] === "'") {
                        out += "'"
                        i += 2
                        continue
                    }
                    i++ // closing quote
                    closed = true
                    break
                }
                out += ch
                i++
            }
            if (!closed) {
                throw new Error(`unterminated string literal starting near: ${JSON.stringify(payload.slice(Math.max(0, i - 20), i))}`)
            }
            tokens.push({ kind: "string", value: out })
            continue
        }

        // Bareword: NULL / true / false / numeric.
        let j = i
        while (
            j < n &&
            payload[j] !== "," &&
            payload[j] !== " " &&
            payload[j] !== "\t" &&
            payload[j] !== "\n" &&
            payload[j] !== "\r"
        ) {
            j++
        }
        const raw = payload.slice(i, j)
        i = j

        const upper = raw.toUpperCase()
        if (upper === "NULL") {
            tokens.push({ kind: "null" })
            continue
        }
        if (upper === "TRUE") {
            tokens.push({ kind: "bool", value: true })
            continue
        }
        if (upper === "FALSE") {
            tokens.push({ kind: "bool", value: false })
            continue
        }

        // Numeric. Allow leading `-`, digits, optional fractional. No
        // scientific notation expected in these dumps.
        if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
            if (raw.includes(".")) {
                tokens.push({ kind: "number", value: Number(raw) })
            } else {
                // Integer. Prefer bigint to preserve precision; downstream
                // decides whether to coerce.
                tokens.push({ kind: "bigint", value: BigInt(raw) })
            }
            continue
        }

        throw new Error(`unparseable bareword: ${JSON.stringify(raw)}`)
    }

    return tokens
}

/**
 * Split an INSERT header into its column list.
 * Accepts both quoted (`"camelCase"`) and unquoted column names.
 */
export function parseColumnList(columnsRaw: string): string[] {
    const cols: string[] = []
    let i = 0
    const n = columnsRaw.length
    while (i < n) {
        const c = columnsRaw[i]
        if (c === " " || c === "\t" || c === ",") {
            i++
            continue
        }
        if (c === '"') {
            let j = i + 1
            while (j < n && columnsRaw[j] !== '"') j++
            cols.push(columnsRaw.slice(i + 1, j))
            i = j + 1
            continue
        }
        let j = i
        while (
            j < n &&
            columnsRaw[j] !== "," &&
            columnsRaw[j] !== " " &&
            columnsRaw[j] !== "\t"
        ) {
            j++
        }
        cols.push(columnsRaw.slice(i, j))
        i = j
    }
    return cols
}

export type InsertHeader =
    | {
          table: "gcr_main" | "gcr_storageprogram" | "identity_commitments"
          columns: string[]
          valuesPayload: string
      }
    | { table: null }

/**
 * Splits a single INSERT statement line into (table, columns, values-payload).
 * Expects pg_dump --column-inserts style on a single line ending with `);`.
 */
export function parseInsert(line: string): InsertHeader | null {
    if (!line.startsWith("INSERT INTO public.")) return null

    // Header: INSERT INTO public.<table> (<columns>) VALUES (<payload>);
    const tableStart = "INSERT INTO public.".length
    const openParen = line.indexOf(" (", tableStart)
    if (openParen < 0) {
        throw new Error("malformed INSERT header (no column list)")
    }
    const tableName = line.slice(tableStart, openParen)

    if (
        tableName !== "gcr_main" &&
        tableName !== "gcr_storageprogram" &&
        tableName !== "identity_commitments"
    ) {
        // Unknown table — returns InsertHeader with table=null; processLines silently skips.
        return { table: null }
    }

    const valuesMarker = " VALUES ("
    const valuesIdx = line.indexOf(valuesMarker, openParen)
    if (valuesIdx < 0) throw new Error("missing VALUES clause")
    const columnsRaw = line.slice(openParen + 2, valuesIdx - 1) // exclude the `)`
    const payloadStart = valuesIdx + valuesMarker.length

    // Trailing must be `);` (with optional trailing whitespace).
    let end = line.length - 1
    while (end >= 0 && (line[end] === " " || line[end] === "\t")) end--
    if (line[end] !== ";") throw new Error("missing trailing semicolon")
    end--
    if (line[end] !== ")") throw new Error("missing closing paren")
    const payload = line.slice(payloadStart, end)
    const columns = parseColumnList(columnsRaw)

    return { table: tableName, columns, valuesPayload: payload }
}

/**
 * Convert SqlValue -> JS value suitable for JSON.stringify, given the
 * declared column type for the destination JSONL field.
 *
 * `kind` meanings:
 *   - "string-passthrough" : keep as JS string (text / timestamp)
 *   - "bigint-string"      : preserve precision by emitting JS string
 *   - "int"                : assert fits-in-number, emit JS number
 *   - "bool"               : emit JS boolean
 *   - "json"               : SQL value MUST be a string; JSON.parse and emit
 *                            parsed value (or null)
 *   - "nullable-string"    : string or null
 */
export type FieldKind =
    | "string-passthrough"
    | "bigint-string"
    | "int"
    | "bool"
    | "json"
    | "nullable-string"
    | "simple-array-text"

export function coerceField(
    value: SqlValue,
    kind: FieldKind,
    columnName: string,
): unknown {
    if (value.kind === "null") {
        switch (kind) {
            case "json":
            case "nullable-string":
                return null
            case "simple-array-text":
                return ""
            default:
                throw new Error(
                    `NULL not allowed for column ${columnName} (kind=${kind})`,
                )
        }
    }

    switch (kind) {
        case "string-passthrough":
        case "nullable-string":
            if (value.kind !== "string") {
                throw new Error(
                    `expected string for ${columnName}, got ${value.kind}`,
                )
            }
            return value.value
        case "simple-array-text":
            if (value.kind !== "string") {
                throw new Error(
                    `expected string for ${columnName}, got ${value.kind}`,
                )
            }
            return value.value
        case "bigint-string":
            if (value.kind === "bigint") return value.value.toString()
            if (value.kind === "number") {
                if (!Number.isSafeInteger(value.value)) {
                    throw new Error(
                        `bigint-string column ${columnName} received a non-integer or out-of-safe-range number: ${value.value}`,
                    )
                }
                return value.value.toString()
            }
            throw new Error(
                `expected bigint for ${columnName}, got ${value.kind}`,
            )
        case "int":
            if (value.kind === "bigint") {
                const asNumber = Number(value.value)
                if (!Number.isSafeInteger(asNumber)) {
                    throw new Error(
                        `integer ${value.value} for ${columnName} out of safe range`,
                    )
                }
                return asNumber
            }
            if (value.kind === "number") {
                if (!Number.isSafeInteger(value.value)) {
                    throw new Error(
                        `non-integer numeric for ${columnName}: ${value.value}`,
                    )
                }
                return value.value
            }
            throw new Error(`expected int for ${columnName}, got ${value.kind}`)
        case "bool":
            if (value.kind !== "bool") {
                throw new Error(
                    `expected bool for ${columnName}, got ${value.kind}`,
                )
            }
            return value.value
        case "json": {
            if (value.kind !== "string") {
                throw new Error(
                    `expected stringified JSON for ${columnName}, got ${value.kind}`,
                )
            }
            try {
                return JSON.parse(value.value)
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                throw new Error(
                    `invalid JSON in ${columnName}: ${msg}; raw=${value.value.slice(0, 200)}`,
                )
            }
        }
        default: {
            const exhaustive: never = kind
            throw new Error(`unreachable: ${exhaustive as string}`)
        }
    }
}

// Per-column type plans (must match state-schema.sql).
export const GCR_MAIN_KINDS: Record<GcrMainCol, FieldKind> = {
    pubkey: "string-passthrough",
    assignedTxs: "json",
    nonce: "int",
    balance: "bigint-string",
    identities: "json",
    points: "json",
    referralInfo: "json",
    flagged: "bool",
    flaggedReason: "string-passthrough",
    reviewed: "bool",
    createdAt: "string-passthrough",
    updatedAt: "string-passthrough",
}

export const STORAGE_KINDS: Record<StorageCol, FieldKind> = {
    storageAddress: "string-passthrough",
    owner: "string-passthrough",
    programName: "string-passthrough",
    encoding: "string-passthrough",
    data: "json",
    sizeBytes: "int",
    acl: "json",
    metadata: "json",
    storageLocation: "string-passthrough",
    ipfsCid: "nullable-string",
    salt: "nullable-string",
    createdByTx: "string-passthrough",
    lastModifiedByTx: "string-passthrough",
    totalFeesPaid: "bigint-string",
    isDeleted: "bool",
    interactionTxs: "simple-array-text",
    deletedByTx: "nullable-string",
    createdAt: "string-passthrough",
    updatedAt: "string-passthrough",
}

export const IDENTITY_KINDS: Record<IdentityCol, FieldKind> = {
    commitment_hash: "string-passthrough",
    leaf_index: "int",
    provider: "string-passthrough",
    block_number: "int",
    transaction_hash: "string-passthrough",
    timestamp: "bigint-string",
    created_at: "string-passthrough",
}

/**
 * Build a row object with the fixed key order required by the determinism
 * contract. Assumes `colMap` has every key in `orderedCols`.
 */
export function orderRow<T extends string>(
    orderedCols: readonly T[],
    colMap: Map<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const c of orderedCols) {
        if (!colMap.has(c)) {
            throw new Error(`missing column ${c}`)
        }
        out[c] = colMap.get(c)
    }
    return out
}

/**
 * Process a line-oriented async iterable of SQL dump lines (already
 * decompressed) and return the parsed JSONL content + stats. Exported
 * so unit tests can drive the parser with synthetic SQL without touching
 * disk or a real .sql.gz.
 *
 * Unlike `main()`, this function does NOT assert against the hardcoded
 * anchor row-counts/sums — those anchors are only valid for the one
 * committed production dump. Callers (including tests) validate
 * separately.
 */
export type TransformResult = {
    gcrMainLines: string[]
    storageLines: string[]
    identityLines: string[]
    gcrMainRows: number
    storageRows: number
    identityRowsRaw: number
    identityRowsDropped: number
    balanceSum: bigint
    sizeBytesSum: number
}

export async function processLines(
    lines: AsyncIterable<string>,
): Promise<TransformResult> {
    const gcrMainLines: string[] = []
    const storageLines: string[] = []
    const identityLines: string[] = []

    let lineNo = 0
    let gcrMainRows = 0
    let storageRows = 0
    let identityRowsRaw = 0
    let identityRowsDropped = 0
    let balanceSum = 0n
    let sizeBytesSum = 0
    const skippedTableCount = new Map<string, number>()

    for await (const rawLine of lines) {
        lineNo++
        if (!rawLine.startsWith("INSERT INTO public.")) continue

        let header: InsertHeader
        try {
            const parsed = parseInsert(rawLine)
            if (!parsed) continue
            header = parsed
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`line ${lineNo}: ${msg}`)
        }

        if (header.table === null) {
            // Unknown table — silently skip. Extract table name for debug
            // summary logged once at end of pass.
            const tableStart = "INSERT INTO public.".length
            const spaceIdx = rawLine.indexOf(" ", tableStart)
            const skippedTable =
                spaceIdx > 0
                    ? rawLine.slice(tableStart, spaceIdx)
                    : rawLine.slice(tableStart, tableStart + 40)
            skippedTableCount.set(
                skippedTable,
                (skippedTableCount.get(skippedTable) ?? 0) + 1,
            )
            continue
        }

        // After the null-table guard above, narrow to the known-table variant
        // explicitly so TypeScript can access columns/valuesPayload safely.
        const knownHeader = header as {
            table: "gcr_main" | "gcr_storageprogram" | "identity_commitments"
            columns: string[]
            valuesPayload: string
        }

        let values: SqlValue[]
        try {
            values = parseValuesPayload(knownHeader.valuesPayload)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`line ${lineNo}: value parse failed: ${msg}`)
        }

        if (values.length !== knownHeader.columns.length) {
            throw new Error(
                `line ${lineNo}: column-count mismatch (header=${knownHeader.columns.length}, values=${values.length})`,
            )
        }

        const colMap = new Map<string, unknown>()

        if (knownHeader.table === "gcr_main") {
            for (let k = 0; k < knownHeader.columns.length; k++) {
                const colName = knownHeader.columns[k] as GcrMainCol
                const kind = GCR_MAIN_KINDS[colName]
                if (!kind) {
                    throw new Error(
                        `line ${lineNo}: unknown gcr_main column ${colName}`,
                    )
                }
                colMap.set(colName, coerceField(values[k], kind, colName))
            }
            colMap.set("nonce", 0)
            colMap.set("assignedTxs", [])
            const balanceStr = colMap.get("balance")
            if (typeof balanceStr !== "string") {
                throw new Error(`line ${lineNo}: gcr_main.balance must be string`)
            }
            balanceSum += BigInt(balanceStr)
            const ordered = orderRow(GCR_MAIN_COLUMNS, colMap)
            gcrMainLines.push(JSON.stringify(ordered) + "\n")
            gcrMainRows++
        } else if (knownHeader.table === "gcr_storageprogram") {
            for (let k = 0; k < knownHeader.columns.length; k++) {
                const colName = knownHeader.columns[k] as StorageCol
                const kind = STORAGE_KINDS[colName]
                if (!kind) {
                    throw new Error(
                        `line ${lineNo}: unknown gcr_storageprogram column ${colName}`,
                    )
                }
                colMap.set(colName, coerceField(values[k], kind, colName))
            }
            const sizeBytes = colMap.get("sizeBytes")
            if (typeof sizeBytes !== "number") {
                throw new Error(
                    `line ${lineNo}: gcr_storageprogram.sizeBytes must be number`,
                )
            }
            sizeBytesSum += sizeBytes
            const ordered = orderRow(STORAGE_COLUMNS, colMap)
            storageLines.push(JSON.stringify(ordered) + "\n")
            storageRows++
        } else {
            // identity_commitments
            for (let k = 0; k < knownHeader.columns.length; k++) {
                const colName = knownHeader.columns[k] as IdentityCol
                const kind = IDENTITY_KINDS[colName]
                if (!kind) {
                    throw new Error(
                        `line ${lineNo}: unknown identity_commitments column ${colName}`,
                    )
                }
                colMap.set(colName, coerceField(values[k], kind, colName))
            }
            identityRowsRaw++
            const provider = colMap.get("provider")
            const leafIndex = colMap.get("leaf_index")
            if (provider === "test" && leafIndex === -1) {
                identityRowsDropped++
                continue
            }
            const ordered = orderRow(IDENTITY_COLUMNS, colMap)
            identityLines.push(JSON.stringify(ordered) + "\n")
        }
    }

    if (skippedTableCount.size > 0) {
        const summary = Array.from(skippedTableCount.entries())
            .map(([table, count]) => `${table}=${count}`)
            .join(", ")
        console.debug(`[transform] skipped INSERT rows for unknown tables: ${summary}`)
    }

    return {
        gcrMainLines,
        storageLines,
        identityLines,
        gcrMainRows,
        storageRows,
        identityRowsRaw,
        identityRowsDropped,
        balanceSum,
        sizeBytesSum,
    }
}

async function main(): Promise<void> {
    await mkdir(OUT_DIR, { recursive: true })

    const gz = createReadStream(SOURCE_PATH)
    const gunzip = createGunzip()
    const rl = createInterface({
        input: gz.pipe(gunzip),
        crlfDelay: Infinity,
    })

    const result = await processLines(rl)
    const {
        gcrMainLines, storageLines, identityLines,
        gcrMainRows, storageRows,
        identityRowsRaw, identityRowsDropped,
        balanceSum, sizeBytesSum,
    } = result

    // Sanity assertions against pre-known anchor values.
    if (gcrMainRows !== EXPECTED_GCR_MAIN_ROWS) {
        throw new Error(
            `gcr_main row count mismatch: got ${gcrMainRows}, expected ${EXPECTED_GCR_MAIN_ROWS}`,
        )
    }
    if (storageRows !== EXPECTED_STORAGE_ROWS) {
        throw new Error(
            `gcr_storageprogram row count mismatch: got ${storageRows}, expected ${EXPECTED_STORAGE_ROWS}`,
        )
    }
    if (balanceSum !== EXPECTED_BALANCE_SUM) {
        throw new Error(
            `balance_sum mismatch: got ${balanceSum}, expected ${EXPECTED_BALANCE_SUM}`,
        )
    }
    if (sizeBytesSum !== EXPECTED_SIZE_BYTES_SUM) {
        throw new Error(
            `size_bytes_sum mismatch: got ${sizeBytesSum}, expected ${EXPECTED_SIZE_BYTES_SUM}`,
        )
    }
    if (identityRowsDropped !== EXPECTED_IDENTITY_COMMITMENT_DROPS) {
        throw new Error(
            `identity_commitments drop count mismatch: got ${identityRowsDropped}, expected ${EXPECTED_IDENTITY_COMMITMENT_DROPS}`,
        )
    }
    if (identityLines.length !== identityRowsRaw - identityRowsDropped) {
        throw new Error("internal: identity_commitments accounting broken")
    }

    const gcrMainBody = gcrMainLines.join("")
    const storageBody = storageLines.join("")
    const identityBody = identityLines.join("")

    const gcrMainSha = createHash("sha256").update(gcrMainBody).digest("hex")
    const storageSha = createHash("sha256").update(storageBody).digest("hex")
    const identitySha = createHash("sha256").update(identityBody).digest("hex")

    const gcrMainPath = resolve(OUT_DIR, "gcr_main.jsonl")
    const storagePath = resolve(OUT_DIR, "gcr_storageprogram.jsonl")
    const identityPath = resolve(OUT_DIR, "identity_commitments.jsonl")
    const manifestPath = resolve(OUT_DIR, "manifest.json")

    await writeFile(gcrMainPath, gcrMainBody)
    await writeFile(storagePath, storageBody)
    // Emit an empty file (0 lines, 0 bytes) for identity_commitments so the
    // verifier + downstream loader logic remains uniform across tables.
    await writeFile(identityPath, identityBody)

    const manifest = {
        schemaVersion: 1,
        source: SOURCE_META,
        files: {
            "gcr_main.jsonl": {
                sha256: gcrMainSha,
                rows: gcrMainRows,
                balance_sum: balanceSum.toString(),
            },
            "gcr_storageprogram.jsonl": {
                sha256: storageSha,
                rows: storageRows,
                size_bytes_sum: sizeBytesSum,
            },
            "identity_commitments.jsonl": {
                sha256: identitySha,
                rows: identityLines.length,
            },
        },
        transforms_applied: {
            nonces_reset_to_zero: true,
            assigned_txs_emptied: true,
            test_identity_commitments_dropped: identityRowsDropped,
        },
    }

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

    console.log("snapshot transform complete")
    console.log(`  gcr_main.jsonl              ${gcrMainRows} rows  sha256=${gcrMainSha}`)
    console.log(`  gcr_storageprogram.jsonl    ${storageRows} rows  sha256=${storageSha}`)
    console.log(`  identity_commitments.jsonl  ${identityLines.length} rows  sha256=${identitySha}`)
    console.log(`  balance_sum                 ${balanceSum.toString()}`)
    console.log(`  size_bytes_sum              ${sizeBytesSum}`)
    console.log(`  identity rows dropped       ${identityRowsDropped}`)
}

main().catch((err) => {
    console.error("transform failed:", err instanceof Error ? err.message : err)
    if (err instanceof Error && err.stack) console.error(err.stack)
    process.exit(1)
})
