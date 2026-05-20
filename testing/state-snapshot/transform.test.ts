/**
 * P4-T1 — Unit tests for scripts/state-snapshot/transform.ts
 *
 * Exercises the exported pure-parsing functions:
 *   - parseValuesPayload   (SQL tokenizer)
 *   - parseInsert          (INSERT line splitter)
 *   - coerceField          (typed value coercion)
 *   - processLines         (full pipeline, no disk I/O)
 *
 * Fixtures are generated inline (no real 213 MB dump), gzip-compressed
 * using Node's `zlib.gzipSync`, then decompressed back to a line stream
 * so `processLines` sees exactly what it would in production.
 *
 * Test isolation: no DB, no disk writes — all pure in-memory.
 */

import { describe, it, expect } from "bun:test"
import { gzipSync, gunzipSync } from "node:zlib"
import { createHash } from "node:crypto"

import {
    parseValuesPayload,
    parseInsert,
    coerceField,
    processLines,
    type SqlValue,
    type FieldKind,
} from "../../scripts/state-snapshot/transform"

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert a plain SQL text blob to the compressed+decompressed line stream
 * that processLines() expects. We gzip then gunzip in the same call so the
 * round-trip exercises the zlib codec without actual disk I/O.
 */
function sqlToLines(sql: string): AsyncIterable<string> {
    const compressed = gzipSync(Buffer.from(sql, "utf8"))
    const decompressed = gunzipSync(compressed).toString("utf8")
    const lines = decompressed.split("\n")
    // Return as an async iterable
    return (async function* () {
        for (const line of lines) {
            yield line
        }
    })()
}

// Column lists (mirrors what the transform script expects in INSERT headers)
const GCR_MAIN_COLS = [
    '"pubkey"',
    '"assignedTxs"',
    '"nonce"',
    '"balance"',
    '"identities"',
    '"points"',
    '"referralInfo"',
    '"flagged"',
    '"flaggedReason"',
    '"reviewed"',
    '"createdAt"',
    '"updatedAt"',
].join(", ")

const STORAGE_COLS = [
    '"storageAddress"',
    '"owner"',
    '"programName"',
    '"encoding"',
    '"data"',
    '"sizeBytes"',
    '"acl"',
    '"metadata"',
    '"storageLocation"',
    '"ipfsCid"',
    '"salt"',
    '"createdByTx"',
    '"lastModifiedByTx"',
    '"totalFeesPaid"',
    '"isDeleted"',
    '"interactionTxs"',
    '"deletedByTx"',
    '"createdAt"',
    '"updatedAt"',
].join(", ")

const IDENTITY_COLS = [
    "commitment_hash",
    "leaf_index",
    "provider",
    "block_number",
    "transaction_hash",
    "timestamp",
    "created_at",
].join(", ")

/**
 * Builds a minimal single-row INSERT line for gcr_main.
 * `nonce` and `assignedTxs` will be overwritten by the transform.
 */
function makeGcrMainInsert(overrides: {
    pubkey?: string
    assignedTxs?: string
    nonce?: number
    balance?: string
    identities?: string
    points?: string
    referralInfo?: string
    flagged?: string
    flaggedReason?: string
    reviewed?: string
    createdAt?: string
    updatedAt?: string
}): string {
    const v = {
        pubkey: "0xaabbcc",
        assignedTxs: "'{}'",
        nonce: 5,
        balance: "1000000000000000000",
        identities: `'{"xm":{}}'`,
        points: `'{}'`,
        referralInfo: `'{}'`,
        flagged: "false",
        flaggedReason: "''",
        reviewed: "false",
        createdAt: "'2025-08-04 11:10:47.903'",
        updatedAt: "'2025-08-04 11:10:47.903'",
        ...overrides,
    }
    return (
        `INSERT INTO public.gcr_main (${GCR_MAIN_COLS}) VALUES (` +
        `'${v.pubkey}', ${v.assignedTxs}, ${v.nonce}, ${v.balance}, ` +
        `${v.identities}, ${v.points}, ${v.referralInfo}, ` +
        `${v.flagged}, ${v.flaggedReason}, ${v.reviewed}, ` +
        `${v.createdAt}, ${v.updatedAt});`
    )
}

/**
 * Builds a minimal single-row INSERT line for gcr_storageprogram.
 */
function makeStorageInsert(overrides: {
    storageAddress?: string
    owner?: string
    programName?: string
    encoding?: string
    data?: string
    sizeBytes?: number
    acl?: string
    metadata?: string
    storageLocation?: string
    ipfsCid?: string
    salt?: string
    createdByTx?: string
    lastModifiedByTx?: string
    totalFeesPaid?: string
    isDeleted?: string
    interactionTxs?: string
    deletedByTx?: string
    createdAt?: string
    updatedAt?: string
}): string {
    const v = {
        storageAddress: "stor-abc123",
        owner: "0xowner",
        programName: "my-program",
        encoding: "json",
        data: `'{"key":"value"}'`,
        sizeBytes: 42,
        acl: `'{"mode":"public"}'`,
        metadata: "NULL",
        storageLocation: "onchain",
        ipfsCid: "NULL",
        salt: "NULL",
        createdByTx: "0xtxhash",
        lastModifiedByTx: "0xtxhash",
        totalFeesPaid: "21",
        isDeleted: "false",
        interactionTxs: "'0xtxhash'",
        deletedByTx: "NULL",
        createdAt: "'2026-03-21 13:37:35.973753'",
        updatedAt: "'2026-03-21 13:37:35.973753'",
        ...overrides,
    }
    return (
        `INSERT INTO public.gcr_storageprogram (${STORAGE_COLS}) VALUES (` +
        `'${v.storageAddress}', '${v.owner}', '${v.programName}', '${v.encoding}', ` +
        `${v.data}, ${v.sizeBytes}, ${v.acl}, ${v.metadata}, ` +
        `'${v.storageLocation}', ${v.ipfsCid}, ${v.salt}, ` +
        `'${v.createdByTx}', '${v.lastModifiedByTx}', ${v.totalFeesPaid}, ` +
        `${v.isDeleted}, ${v.interactionTxs}, ${v.deletedByTx}, ` +
        `${v.createdAt}, ${v.updatedAt});`
    )
}

/**
 * Builds an identity_commitments INSERT line. The test row has
 * leaf_index=-1, provider='test' and will be dropped by the transform.
 */
function makeIdentityInsert(overrides: {
    commitment_hash?: string
    leaf_index?: number
    provider?: string
    block_number?: number
    transaction_hash?: string
    timestamp?: string
    created_at?: string
}): string {
    const v = {
        commitment_hash: "0xcommit",
        leaf_index: -1,
        provider: "test",
        block_number: 0,
        transaction_hash: "0xtx",
        timestamp: "1700000000",
        created_at: "'2026-01-01 00:00:00'",
        ...overrides,
    }
    return (
        `INSERT INTO public.identity_commitments (${IDENTITY_COLS}) VALUES (` +
        `'${v.commitment_hash}', ${v.leaf_index}, '${v.provider}', ` +
        `${v.block_number}, '${v.transaction_hash}', ${v.timestamp}, ` +
        `${v.created_at});`
    )
}

// =============================================================================
// Tests: parseValuesPayload
// =============================================================================

describe("parseValuesPayload", () => {
    it("parses a simple string token", () => {
        const result = parseValuesPayload("'hello'")
        expect(result).toHaveLength(1)
        expect(result[0]).toEqual({ kind: "string", value: "hello" })
    })

    it("handles embedded '' SQL escape → single quote in output", () => {
        // SQL 'it''s' should yield the string "it's"
        const result = parseValuesPayload("'it''s a test'")
        expect(result).toHaveLength(1)
        expect(result[0]).toEqual({ kind: "string", value: "it's a test" })
    })

    it("handles multiple '' escapes in a single token", () => {
        // SQL 'a''b''c' -> "a'b'c"
        const result = parseValuesPayload("'a''b''c'")
        expect(result).toHaveLength(1)
        const tok = result[0]
        expect(tok.kind).toBe("string")
        expect((tok as { kind: "string"; value: string }).value).toBe("a'b'c")
    })

    it("parses NULL literal to null kind", () => {
        const result = parseValuesPayload("NULL")
        expect(result).toHaveLength(1)
        expect(result[0]).toEqual({ kind: "null" })
    })

    it("is case-insensitive for NULL", () => {
        const r1 = parseValuesPayload("null")
        const r2 = parseValuesPayload("Null")
        expect(r1[0].kind).toBe("null")
        expect(r2[0].kind).toBe("null")
    })

    it("parses TRUE and FALSE booleans", () => {
        const result = parseValuesPayload("true, false")
        expect(result).toHaveLength(2)
        expect(result[0]).toEqual({ kind: "bool", value: true })
        expect(result[1]).toEqual({ kind: "bool", value: false })
    })

    it("parses a small integer as bigint kind", () => {
        const result = parseValuesPayload("42")
        expect(result).toHaveLength(1)
        expect(result[0]).toEqual({ kind: "bigint", value: 42n })
    })

    it("parses a negative integer", () => {
        const result = parseValuesPayload("-1")
        expect(result).toHaveLength(1)
        expect(result[0]).toEqual({ kind: "bigint", value: -1n })
    })

    it("parses a large integer exceeding Number.MAX_SAFE_INTEGER as bigint", () => {
        // 9999999999999999999 > 2^53-1
        const big = "9999999999999999999"
        const result = parseValuesPayload(big)
        expect(result).toHaveLength(1)
        expect(result[0]).toEqual({ kind: "bigint", value: BigInt(big) })
    })

    it("parses multiple mixed tokens including NULL, string, boolean, int", () => {
        const result = parseValuesPayload("'hello', NULL, true, 100")
        expect(result).toHaveLength(4)
        expect(result[0]).toEqual({ kind: "string", value: "hello" })
        expect(result[1]).toEqual({ kind: "null" })
        expect(result[2]).toEqual({ kind: "bool", value: true })
        expect(result[3]).toEqual({ kind: "bigint", value: 100n })
    })

    it("throws on unparseable bareword", () => {
        expect(() => parseValuesPayload("NOTVALID")).toThrow(/unparseable bareword/)
    })
})

// =============================================================================
// Tests: parseInsert
// =============================================================================

describe("parseInsert", () => {
    it("returns null for non-INSERT lines", () => {
        expect(parseInsert("-- comment")).toBeNull()
        expect(parseInsert("SET search_path = public;")).toBeNull()
        expect(parseInsert("")).toBeNull()
    })

    it("parses a minimal gcr_main INSERT", () => {
        const line = makeGcrMainInsert({})
        const result = parseInsert(line)
        expect(result).not.toBeNull()
        expect(result!.table).toBe("gcr_main")
        // Narrow to the known-table variant after asserting table is set.
        const knownResult = result as { table: "gcr_main"; columns: string[]; valuesPayload: string }
        expect(knownResult.columns).toContain("pubkey")
        expect(knownResult.columns).toContain("balance")
        expect(knownResult.valuesPayload).toBeTruthy()
    })

    it("parses a gcr_storageprogram INSERT", () => {
        const line = makeStorageInsert({})
        const result = parseInsert(line)
        expect(result).not.toBeNull()
        expect(result!.table).toBe("gcr_storageprogram")
    })

    it("parses an identity_commitments INSERT", () => {
        const line = makeIdentityInsert({})
        const result = parseInsert(line)
        expect(result).not.toBeNull()
        expect(result!.table).toBe("identity_commitments")
    })

    it("returns { table: null } for INSERT to unknown table (processLines silently skips)", () => {
        const line =
            "INSERT INTO public.unknown_table (col) VALUES ('val');"
        const result = parseInsert(line)
        expect(result).not.toBeNull()
        expect(result!.table).toBeNull()
    })
})

// =============================================================================
// Tests: coerceField
// =============================================================================

describe("coerceField", () => {
    it("bigint-string: preserves a large integer as JS string", () => {
        const token: SqlValue = {
            kind: "bigint",
            value: 9999999999999999999n,
        }
        const result = coerceField(token, "bigint-string", "balance")
        expect(result).toBe("9999999999999999999")
        // Crucially: NOT a JS number (precision loss would change the value)
        expect(typeof result).toBe("string")
    })

    it("bigint-string: emits the exact digit string, no precision loss", () => {
        // This specific value exceeds Number.MAX_SAFE_INTEGER and must NOT be
        // silently truncated to a rounded number.
        const tok: SqlValue = {
            kind: "bigint",
            value: 15024999999998868586n,
        }
        const result = coerceField(tok, "bigint-string", "balance")
        expect(result).toBe("15024999999998868586")
    })

    it("json: parses a stringified JSON object", () => {
        const tok: SqlValue = { kind: "string", value: '{"a":1}' }
        const result = coerceField(tok, "json", "identities")
        expect(result).toEqual({ a: 1 })
    })

    it("json: null token yields null", () => {
        const tok: SqlValue = { kind: "null" }
        const result = coerceField(tok, "json", "metadata")
        expect(result).toBeNull()
    })

    it("nullable-string: null token yields null", () => {
        const tok: SqlValue = { kind: "null" }
        const result = coerceField(tok, "nullable-string", "ipfsCid")
        expect(result).toBeNull()
    })

    it("nullable-string: string token is passed through", () => {
        const tok: SqlValue = { kind: "string", value: "Qmfoo" }
        const result = coerceField(tok, "nullable-string", "ipfsCid")
        expect(result).toBe("Qmfoo")
    })

    it("bool: true/false preserved", () => {
        const t: SqlValue = { kind: "bool", value: true }
        const f: SqlValue = { kind: "bool", value: false }
        expect(coerceField(t, "bool", "flagged")).toBe(true)
        expect(coerceField(f, "bool", "reviewed")).toBe(false)
    })

    it("int: bigint in safe range is a JS number", () => {
        const tok: SqlValue = { kind: "bigint", value: 42n }
        const result = coerceField(tok, "int", "sizeBytes")
        expect(result).toBe(42)
        expect(typeof result).toBe("number")
    })

    it("int: throws if value exceeds safe integer range", () => {
        const tok: SqlValue = { kind: "bigint", value: BigInt(Number.MAX_SAFE_INTEGER) + 1n }
        expect(() => coerceField(tok, "int", "sizeBytes")).toThrow(/out of safe range/)
    })

    it("string-passthrough: rejects non-string token", () => {
        const tok: SqlValue = { kind: "bigint", value: 1n }
        expect(() => coerceField(tok, "string-passthrough", "pubkey")).toThrow(
            /expected string/,
        )
    })
})

// =============================================================================
// Tests: processLines (full pipeline, synthetic fixtures)
// =============================================================================

describe("processLines — happy path roundtrip", () => {
    it("3 gcr_main + 2 gcr_storageprogram + 1 identity(dropped) → correct counts and balance_sum", async () => {
        const rows = [
            // gcr_main × 3
            makeGcrMainInsert({ pubkey: "0xaaa", balance: "1000000000000000000" }),
            makeGcrMainInsert({ pubkey: "0xbbb", balance: "2000000000000000000" }),
            makeGcrMainInsert({ pubkey: "0xccc", balance: "500000000000000000" }),
            // gcr_storageprogram × 2
            makeStorageInsert({ storageAddress: "stor-001", sizeBytes: 100 }),
            makeStorageInsert({ storageAddress: "stor-002", sizeBytes: 200 }),
            // identity_commitments × 1 (test row — must be dropped)
            makeIdentityInsert({ leaf_index: -1, provider: "test" }),
        ]
        const sql = rows.join("\n")
        const lines = sqlToLines(sql)

        const result = await processLines(lines)

        expect(result.gcrMainRows).toBe(3)
        expect(result.storageRows).toBe(2)
        expect(result.identityRowsRaw).toBe(1)
        expect(result.identityRowsDropped).toBe(1)
        expect(result.identityLines).toHaveLength(0)

        // Balance sum: 1e18 + 2e18 + 0.5e18 = 3.5e18
        const expectedSum = 1000000000000000000n + 2000000000000000000n + 500000000000000000n
        expect(result.balanceSum).toBe(expectedSum)

        // Size bytes sum: 100 + 200 = 300
        expect(result.sizeBytesSum).toBe(300)
    })

    it("nonce is reset to 0 regardless of input nonce value", async () => {
        const sql = makeGcrMainInsert({ pubkey: "0xtest", nonce: 999 })
        const result = await processLines(sqlToLines(sql))

        expect(result.gcrMainRows).toBe(1)
        const parsed = JSON.parse(result.gcrMainLines[0])
        expect(parsed.nonce).toBe(0)
    })

    it("assignedTxs is reset to [] regardless of input", async () => {
        // The INSERT uses assignedTxs = '{"tx1","tx2"}' (a PG array), but the
        // transform overwrites it with []. We pass a non-empty JSON array in
        // the INSERT; the test verifies it is replaced.
        const sql = makeGcrMainInsert({
            pubkey: "0xtest",
            assignedTxs: `'["tx1","tx2"]'`,
        })
        const result = await processLines(sqlToLines(sql))
        const parsed = JSON.parse(result.gcrMainLines[0])
        expect(parsed.assignedTxs).toEqual([])
    })

    it("sha256 of gcrMainLines is deterministic across two calls with same input", async () => {
        const sql = [
            makeGcrMainInsert({ pubkey: "0xd1", balance: "100" }),
            makeGcrMainInsert({ pubkey: "0xd2", balance: "200" }),
        ].join("\n")

        const r1 = await processLines(sqlToLines(sql))
        const r2 = await processLines(sqlToLines(sql))

        const hash1 = createHash("sha256").update(r1.gcrMainLines.join("")).digest("hex")
        const hash2 = createHash("sha256").update(r2.gcrMainLines.join("")).digest("hex")
        expect(hash1).toBe(hash2)
    })
})

describe("processLines — embedded '' SQL escape", () => {
    it("programName with '' → single apostrophe in JSONL output", async () => {
        // SQL value: 'O''Brien''s program' → JS string "O'Brien's program"
        const sql = makeStorageInsert({
            storageAddress: "stor-quote",
            // We must craft this as the raw VALUES token, not the helper string
        })
        // Override manually — the helper wraps programName with single quotes
        // already; we need to put raw SQL here
        const customInsert =
            `INSERT INTO public.gcr_storageprogram (${STORAGE_COLS}) VALUES (` +
            `'stor-quote-addr', '0xowner', 'O''Brien''s program', 'json', ` +
            `'{"k":"v"}', 42, '{"mode":"public"}', NULL, ` +
            `'onchain', NULL, NULL, ` +
            `'0xtxhash', '0xtxhash', 21, ` +
            `false, '0xtxhash', NULL, ` +
            `'2026-01-01 00:00:00', '2026-01-01 00:00:00');`

        const result = await processLines(sqlToLines(customInsert))
        expect(result.storageRows).toBe(1)

        const row = JSON.parse(result.storageLines[0])
        expect(row.programName).toBe("O'Brien's program")
    })
})

describe("processLines — NULL literal handling", () => {
    it("gcr_storageprogram row with data=NULL and metadata=NULL emits JSON null (not omitted)", async () => {
        // Build an INSERT where data and metadata are SQL NULL
        const customInsert =
            `INSERT INTO public.gcr_storageprogram (${STORAGE_COLS}) VALUES (` +
            `'stor-nulldata', '0xowner', 'null-prog', 'json', ` +
            `NULL, 42, '{"mode":"public"}', NULL, ` +
            `'onchain', NULL, NULL, ` +
            `'0xtxhash', '0xtxhash', 0, ` +
            `false, '', NULL, ` +
            `'2026-01-01 00:00:00', '2026-01-01 00:00:00');`

        const result = await processLines(sqlToLines(customInsert))
        expect(result.storageRows).toBe(1)

        const row = JSON.parse(result.storageLines[0])
        // Both fields must be the JSON null literal, NOT missing from the object.
        expect("data" in row).toBe(true)
        expect("metadata" in row).toBe(true)
        expect(row.data).toBeNull()
        expect(row.metadata).toBeNull()
    })
})

describe("processLines — bigint precision preservation", () => {
    it("balance 9999999999999999999 is emitted as the string '9999999999999999999' (not a rounded number)", async () => {
        // 9999999999999999999 > Number.MAX_SAFE_INTEGER; JSON.stringify of a
        // number would emit 10000000000000000000 (rounded). The transform
        // must keep it as a JSON string.
        const bigBalance = "9999999999999999999"
        const sql = makeGcrMainInsert({ pubkey: "0xbig", balance: bigBalance })
        const result = await processLines(sqlToLines(sql))
        expect(result.gcrMainRows).toBe(1)

        const jsonLine = result.gcrMainLines[0]
        const row = JSON.parse(jsonLine)
        // Must be a string, not a number
        expect(typeof row.balance).toBe("string")
        // Must match exactly — no rounding
        expect(row.balance).toBe(bigBalance)
    })
})

describe("processLines — column count mismatch", () => {
    it("throws with a line number when VALUES has one too many columns", async () => {
        // Build an INSERT with an extra value token — the transform must
        // detect the mismatch and throw referencing the line number.
        const extraValueInsert =
            `INSERT INTO public.gcr_main (${GCR_MAIN_COLS}) VALUES (` +
            `'0xpk', '[]', 0, 100, '{}', '{}', '{}', false, '', false, ` +
            `'2026-01-01 00:00:00', '2026-01-01 00:00:00', 'EXTRA_TOKEN');`

        await expect(processLines(sqlToLines(extraValueInsert))).rejects.toThrow(
            /column-count mismatch/,
        )
    })

    it("the column-count mismatch error references 'line'", async () => {
        // Multiple preamble lines so line number is > 1; the error must
        // still mention "line" somewhere (exact number is implementation detail).
        const sql =
            "-- preamble comment\n" +
            "SET search_path = public;\n" +
            `INSERT INTO public.gcr_main (${GCR_MAIN_COLS}) VALUES (` +
            `'0xpk', '[]', 0, 100, '{}', '{}', '{}', false, '', false, ` +
            `'2026-01-01 00:00:00', '2026-01-01 00:00:00', 'EXTRA');`

        let caught: Error | null = null
        try {
            await processLines(sqlToLines(sql))
        } catch (e) {
            caught = e as Error
        }
        expect(caught).not.toBeNull()
        expect(caught!.message).toMatch(/line \d+/)
        expect(caught!.message).toMatch(/column-count mismatch/)
    })
})

describe("processLines — identity_commitments test row drop", () => {
    it("drops test row (leaf_index=-1, provider=test) and keeps real rows", async () => {
        const sql = [
            makeIdentityInsert({ leaf_index: -1, provider: "test", commitment_hash: "0xdrop" }),
            makeIdentityInsert({
                leaf_index: 0,
                provider: "real",
                commitment_hash: "0xkeep",
                // must not be dropped
            }),
        ].join("\n")

        const result = await processLines(sqlToLines(sql))
        expect(result.identityRowsRaw).toBe(2)
        expect(result.identityRowsDropped).toBe(1)
        expect(result.identityLines).toHaveLength(1)

        const row = JSON.parse(result.identityLines[0])
        expect(row.commitment_hash).toBe("0xkeep")
    })
})
