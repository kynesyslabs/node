/**
 * State-snapshot loader (P1-T1).
 *
 * Streams JSONL rows from `data/snapshot/{gcr_main,gcr_storageprogram,identity_commitments}.jsonl`
 * for consumption by the genesis builder (`restoreSnapshot.ts`).
 *
 * Responsibilities:
 *   1. Resolve the snapshot directory (env override `DEMOS_SNAPSHOT_DIR`,
 *      default `<cwd>/data/snapshot`).
 *   2. If the directory or manifest is missing → return a non-error
 *      sentinel `{ available: false }`. Empty-chain dev boots are
 *      legitimate; we do NOT force operators to ship a snapshot.
 *   3. If present → run the shared integrity gate (sha256 + row counts
 *      + balance/size sums). Any mismatch throws with an operator-facing
 *      message before the caller is allowed to touch the DB.
 *   4. Expose `streamGcr*` async iterables that emit one typed seed per
 *      line, skipping empty lines defensively (identity_commitments.jsonl
 *      is intentionally a zero-row file).
 *   5. Expose `getSnapshotManifest()` for callers that want to log /
 *      record the source-chain metadata.
 *
 * NOTE: types here intentionally pre-normalize the JSONL shapes that
 * `scripts/state-snapshot/transform.ts` emits. The transformer preserves
 * `balance` and `totalFeesPaid` as JSON strings to avoid double-precision
 * loss; this loader converts to `bigint` at the boundary so callers stay
 * in entity-shape territory.
 */

import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import { resolve } from "node:path"

import {
    verifySnapshot,
    type SnapshotManifest,
} from "src/libs/blockchain/genesis/verifySnapshot"

// ----------------------------------------------------------------------------
// Seed types — the shape that `restoreSnapshot.ts` receives per row.
// ----------------------------------------------------------------------------

/**
 * One gcr_main row, normalized for insertion into the GCRMain entity.
 *
 * `balance` is converted from the JSONL string into `bigint` so callers
 * can hand the seed straight to `entityManager.insert(GCRMain, seed)`.
 * The numeric column on GCRMain carries a bigint transformer that will
 * stringify on the way out.
 *
 * `createdAt` / `updatedAt` are preserved as JS Date objects (PG accepts
 * either a Date or a parseable string, but Date keeps the path uniform
 * for downstream consumers).
 */
export type GCRMainSeed = {
    pubkey: string
    assignedTxs: string[]
    nonce: number
    balance: bigint
    identities: Record<string, unknown>
    points: Record<string, unknown>
    referralInfo: Record<string, unknown>
    flagged: boolean
    flaggedReason: string
    reviewed: boolean
    createdAt: Date
    updatedAt: Date
}

/**
 * One gcr_storageprogram row, normalized for insertion into the
 * GCRStorageProgram entity.
 *
 * `totalFeesPaid` is bigint at the boundary; the entity transformer
 * stringifies on write.
 *
 * `interactionTxs` comes off-disk as the raw comma-separated string
 * encoded by PG's `simple-array` (e.g. `"a,b,,c"`). The entity property
 * is typed `string[]`, so we split here.
 */
export type GCRStorageProgramSeed = {
    storageAddress: string
    owner: string
    programName: string
    encoding: string
    data: Record<string, unknown> | string | null
    sizeBytes: number
    acl: Record<string, unknown>
    metadata: Record<string, unknown> | null
    storageLocation: string
    ipfsCid: string | null
    salt: string | null
    createdByTx: string
    lastModifiedByTx: string
    totalFeesPaid: bigint
    isDeleted: boolean
    interactionTxs: string[]
    deletedByTx: string | null
    createdAt: Date
    updatedAt: Date
}

/**
 * One identity_commitments row, normalized for insertion into the
 * IdentityCommitment entity.
 *
 * The JSONL uses snake_case (mirrors the source PG columns); the entity
 * uses camelCase property names. We translate at the loader boundary so
 * `restoreSnapshot.ts` can pass the seed straight to TypeORM.
 *
 * `timestamp` stays as the JSONL string — the entity column is `bigint`
 * and TypeORM/`pg` return that as a string anyway.
 */
export type IdentityCommitmentSeed = {
    commitmentHash: string
    leafIndex: number
    provider: string
    blockNumber: number
    transactionHash: string
    timestamp: string
    createdAt: Date
}

/**
 * One validators row, normalized for insertion into the Validators entity.
 *
 * The `Validators` entity uses snake_case property names that match its
 * columns, so the JSONL keys, the seed keys, and the column names all line
 * up — no translation needed (unlike identity_commitments). `staked_amount`
 * stays a string (the column is text bigint-as-string).
 *
 * Only present in schemaVersion 2 snapshots.
 */
export type ValidatorSeed = {
    address: string
    status: string | null
    connection_url: string | null
    staked_amount: string
    first_seen: number | null
    valid_at: number | null
    unstake_requested_at: number | null
    unstake_available_at: number | null
}

// ----------------------------------------------------------------------------
// Loader public API
// ----------------------------------------------------------------------------

export type SnapshotLoaderUnavailable = { available: false }

export type SnapshotLoaderAvailable = {
    available: true
    snapshotDir: string
    manifest: SnapshotManifest
    streamGcrMain: () => AsyncIterable<GCRMainSeed>
    streamGcrStorageProgram: () => AsyncIterable<GCRStorageProgramSeed>
    streamIdentityCommitments: () => AsyncIterable<IdentityCommitmentSeed>
    // Yields nothing when the snapshot carries no validators.jsonl (v1).
    streamValidators: () => AsyncIterable<ValidatorSeed>
    getSnapshotManifest: () => SnapshotManifest
}

export type SnapshotLoader = SnapshotLoaderUnavailable | SnapshotLoaderAvailable

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

function resolveSnapshotDir(): string {
    const fromEnv = process.env.DEMOS_SNAPSHOT_DIR
    if (fromEnv && fromEnv.length > 0) {
        return resolve(fromEnv)
    }
    return resolve(process.cwd(), "data", "snapshot")
}

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === "object" && x !== null && !Array.isArray(x)
}

function requireString(obj: Record<string, unknown>, key: string): string {
    const v = obj[key]
    if (typeof v !== "string") {
        throw new Error(`field ${key} must be string, got ${typeof v}`)
    }
    return v
}

function optionalString(
    obj: Record<string, unknown>,
    key: string,
): string | null {
    const v = obj[key]
    if (v === null || v === undefined) return null
    if (typeof v !== "string") {
        throw new Error(`field ${key} must be string|null, got ${typeof v}`)
    }
    return v
}

function requireInt(obj: Record<string, unknown>, key: string): number {
    const v = obj[key]
    if (typeof v !== "number" || !Number.isSafeInteger(v)) {
        throw new Error(`field ${key} must be safe integer, got ${typeof v}`)
    }
    return v
}

function optionalInt(obj: Record<string, unknown>, key: string): number | null {
    const v = obj[key]
    if (v === null || v === undefined) return null
    if (typeof v !== "number" || !Number.isSafeInteger(v)) {
        throw new Error(`field ${key} must be safe integer|null, got ${typeof v}`)
    }
    return v
}

function requireBool(obj: Record<string, unknown>, key: string): boolean {
    const v = obj[key]
    if (typeof v !== "boolean") {
        throw new Error(`field ${key} must be boolean, got ${typeof v}`)
    }
    return v
}

function requireRecord(
    obj: Record<string, unknown>,
    key: string,
): Record<string, unknown> {
    const v = obj[key]
    if (!isRecord(v)) {
        throw new Error(`field ${key} must be object`)
    }
    return v
}

function requireStringArray(
    obj: Record<string, unknown>,
    key: string,
): string[] {
    const v = obj[key]
    if (!Array.isArray(v)) {
        throw new Error(`field ${key} must be array`)
    }
    for (const el of v) {
        if (typeof el !== "string") {
            throw new Error(`field ${key} array element must be string`)
        }
    }
    return v as string[]
}

function parseDate(value: unknown, key: string): Date {
    if (!(typeof value === "string" || value instanceof Date)) {
        throw new Error(`field ${key} must be date-string|Date`)
    }
    const d = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(d.getTime())) {
        throw new Error(`field ${key} unparseable as date: ${String(value)}`)
    }
    return d
}

function parseGCRMainRow(line: string, lineNo: number): GCRMainSeed {
    const obj: unknown = JSON.parse(line)
    if (!isRecord(obj)) {
        throw new Error(`gcr_main row ${lineNo}: not an object`)
    }
    return {
        pubkey: requireString(obj, "pubkey"),
        assignedTxs: requireStringArray(obj, "assignedTxs"),
        nonce: requireInt(obj, "nonce"),
        balance: BigInt(requireString(obj, "balance")),
        identities: requireRecord(obj, "identities"),
        points: requireRecord(obj, "points"),
        referralInfo: requireRecord(obj, "referralInfo"),
        flagged: requireBool(obj, "flagged"),
        flaggedReason: requireString(obj, "flaggedReason"),
        reviewed: requireBool(obj, "reviewed"),
        createdAt: parseDate(obj.createdAt, "createdAt"),
        updatedAt: parseDate(obj.updatedAt, "updatedAt"),
    }
}

/**
 * Decode the PG `simple-array` text representation back into a string
 * array. The transformer in the StorageProgram entity rejoins arrays
 * with `,` and trusts that elements contain no commas; we mirror that
 * here. Empty input → empty array.
 */
function decodeSimpleArray(raw: unknown, key: string): string[] {
    if (raw === null || raw === undefined) return []
    if (Array.isArray(raw)) {
        for (const el of raw) {
            if (typeof el !== "string") {
                throw new Error(
                    `field ${key} array element must be string`,
                )
            }
        }
        return raw as string[]
    }
    if (typeof raw !== "string") {
        throw new Error(`field ${key} must be string|array, got ${typeof raw}`)
    }
    if (raw.length === 0) return []
    return raw.split(",")
}

function parseGCRStorageProgramRow(
    line: string,
    lineNo: number,
): GCRStorageProgramSeed {
    const obj: unknown = JSON.parse(line)
    if (!isRecord(obj)) {
        throw new Error(`gcr_storageprogram row ${lineNo}: not an object`)
    }

    // `data` is jsonb — could be object, string, or null. We do NOT
    // normalize beyond shape-asserting.
    const data = obj.data
    if (
        data !== null &&
        typeof data !== "string" &&
        !isRecord(data)
    ) {
        throw new Error(
            `gcr_storageprogram row ${lineNo}: field data must be object|string|null`,
        )
    }

    const metadata = obj.metadata
    if (metadata !== null && !isRecord(metadata)) {
        throw new Error(
            `gcr_storageprogram row ${lineNo}: field metadata must be object|null`,
        )
    }

    return {
        storageAddress: requireString(obj, "storageAddress"),
        owner: requireString(obj, "owner"),
        programName: requireString(obj, "programName"),
        encoding: requireString(obj, "encoding"),
        data: data as Record<string, unknown> | string | null,
        sizeBytes: requireInt(obj, "sizeBytes"),
        acl: requireRecord(obj, "acl"),
        metadata: metadata as Record<string, unknown> | null,
        storageLocation: requireString(obj, "storageLocation"),
        ipfsCid: optionalString(obj, "ipfsCid"),
        salt: optionalString(obj, "salt"),
        createdByTx: requireString(obj, "createdByTx"),
        lastModifiedByTx: requireString(obj, "lastModifiedByTx"),
        totalFeesPaid: BigInt(requireString(obj, "totalFeesPaid")),
        isDeleted: requireBool(obj, "isDeleted"),
        interactionTxs: decodeSimpleArray(obj.interactionTxs, "interactionTxs"),
        deletedByTx: optionalString(obj, "deletedByTx"),
        createdAt: parseDate(obj.createdAt, "createdAt"),
        updatedAt: parseDate(obj.updatedAt, "updatedAt"),
    }
}

function parseIdentityCommitmentRow(
    line: string,
    lineNo: number,
): IdentityCommitmentSeed {
    const obj: unknown = JSON.parse(line)
    if (!isRecord(obj)) {
        throw new Error(`identity_commitments row ${lineNo}: not an object`)
    }
    // JSONL keys are snake_case (mirror source PG columns); translate to
    // entity-property camelCase here.
    return {
        commitmentHash: requireString(obj, "commitment_hash"),
        leafIndex: requireInt(obj, "leaf_index"),
        provider: requireString(obj, "provider"),
        blockNumber: requireInt(obj, "block_number"),
        transactionHash: requireString(obj, "transaction_hash"),
        timestamp: requireString(obj, "timestamp"),
        createdAt: parseDate(obj.created_at, "created_at"),
    }
}

function parseValidatorRow(line: string, lineNo: number): ValidatorSeed {
    const obj: unknown = JSON.parse(line)
    if (!isRecord(obj)) {
        throw new Error(`validators row ${lineNo}: not an object`)
    }
    return {
        address: requireString(obj, "address"),
        status: optionalString(obj, "status"),
        connection_url: optionalString(obj, "connection_url"),
        staked_amount: requireString(obj, "staked_amount"),
        first_seen: optionalInt(obj, "first_seen"),
        valid_at: optionalInt(obj, "valid_at"),
        unstake_requested_at: optionalInt(obj, "unstake_requested_at"),
        unstake_available_at: optionalInt(obj, "unstake_available_at"),
    }
}

async function* streamLines(path: string): AsyncIterable<{
    line: string
    lineNo: number
}> {
    const rl = createInterface({
        input: createReadStream(path),
        crlfDelay: Infinity,
    })
    let lineNo = 0
    for await (const line of rl) {
        lineNo++
        if (line.length === 0) continue
        yield { line, lineNo }
    }
}

// ----------------------------------------------------------------------------
// Public entry point
// ----------------------------------------------------------------------------

/**
 * Resolve the snapshot directory, run integrity checks, and return a
 * streaming loader. If the directory or manifest is missing, returns
 * `{ available: false }` so the genesis builder can fall through to the
 * legacy `genesisData.balances` path.
 *
 * Any other failure (sha mismatch, row count drift, balance sum drift,
 * malformed manifest, unreadable file) throws — operators MUST resolve
 * before booting a fresh chain.
 */
export async function loadSnapshot(): Promise<SnapshotLoader> {
    const snapshotDir = resolveSnapshotDir()

    // Directory presence: a missing or non-directory entry means no
    // snapshot is being shipped. Treat as "available: false" rather than
    // an error.
    let dirExists = false
    try {
        const s = await stat(snapshotDir)
        dirExists = s.isDirectory()
    } catch {
        dirExists = false
    }
    if (!dirExists) {
        return { available: false }
    }

    const manifestPath = resolve(snapshotDir, "manifest.json")
    const manifestStat = await stat(manifestPath).catch(() => null)
    if (!manifestStat || !manifestStat.isFile()) {
        return { available: false }
    }

    // Integrity gate: throws on any drift. If we got past `stat()` for the
    // dir + manifest above, a verify failure now is a HARD failure (the
    // operator intended to ship a snapshot but it's tampered / stale).
    const manifest = await verifySnapshot(snapshotDir)

    const gcrMainPath = resolve(snapshotDir, "gcr_main.jsonl")
    const storagePath = resolve(snapshotDir, "gcr_storageprogram.jsonl")
    const identityPath = resolve(snapshotDir, "identity_commitments.jsonl")
    const validatorsPath = resolve(snapshotDir, "validators.jsonl")
    // validators.jsonl only exists in schemaVersion 2 snapshots; gate on the
    // manifest entry (verifySnapshot has already confirmed the file if listed).
    const hasValidators = manifest.files["validators.jsonl"] !== undefined

    async function* streamGcrMain(): AsyncIterable<GCRMainSeed> {
        for await (const { line, lineNo } of streamLines(gcrMainPath)) {
            yield parseGCRMainRow(line, lineNo)
        }
    }

    async function* streamGcrStorageProgram(): AsyncIterable<GCRStorageProgramSeed> {
        for await (const { line, lineNo } of streamLines(storagePath)) {
            yield parseGCRStorageProgramRow(line, lineNo)
        }
    }

    async function* streamIdentityCommitments(): AsyncIterable<IdentityCommitmentSeed> {
        for await (const { line, lineNo } of streamLines(identityPath)) {
            yield parseIdentityCommitmentRow(line, lineNo)
        }
    }

    async function* streamValidators(): AsyncIterable<ValidatorSeed> {
        if (!hasValidators) return
        for await (const { line, lineNo } of streamLines(validatorsPath)) {
            yield parseValidatorRow(line, lineNo)
        }
    }

    return {
        available: true,
        snapshotDir,
        manifest,
        streamGcrMain,
        streamGcrStorageProgram,
        streamIdentityCommitments,
        streamValidators,
        getSnapshotManifest: () => manifest,
    }
}
