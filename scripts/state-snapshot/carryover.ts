/* eslint-disable no-console */
/**
 * Builds the snapshot a mainnet genesis imports under `identityCarryover`
 * from a source-network snapshot.
 *
 *   - gcr_main.jsonl: every account row kept, its balance set to "0";
 *     identities, points, referralInfo and every other column untouched,
 *     except the points of the accounts named by --zero-points.
 *   - validators.jsonl: written from the launch validator list, the source
 *     network's validator rows and stakes are dropped.
 *   - gcr_storageprogram.jsonl: copied byte for byte, unless --drop-storage
 *     or --empty-storage names programs to leave out or to empty.
 *   - identity_commitments.jsonl: copied byte for byte.
 *   - manifest.json: the source manifest with the new file entries, the
 *     transform flags and a `carryover` block naming the source manifest
 *     by sha256, plus the sha256 and size of every list given. The launch
 *     list is bound through the validators.jsonl entry, not through the
 *     bytes of the file it was read from: that file is usually the genesis,
 *     which only gets its snapshot.manifestSha256 after this runs.
 *
 * The output is a pure function of the inputs, so anyone can rebuild it and
 * get the same manifest sha256, which is what the genesis binds.
 *
 * Usage:
 *   bun run snapshot:carryover --in data/snapshot \
 *       --validators mainnet/genesis.json --out mainnet/snapshot \
 *       [--zero-points LIST] [--drop-storage LIST] [--empty-storage LIST]
 *
 * --validators takes a genesis file (its `validators` array is used) or a
 * bare JSON array of the same entries: address, status, connection_url
 * (null allowed), staked_amount, first_seen, valid_at.
 *
 * Every LIST is a text file with one address per line, sorted and without
 * repeats (`LC_ALL=C sort -u`), ending with a newline. Its sha256 goes into
 * the manifest, so the published hash names the exact list applied.
 *   --zero-points    account addresses whose points are set to 0
 *                    (totalPoints and every number in the breakdown);
 *                    identities, referralInfo and flags are kept.
 *   --drop-storage   storage program addresses whose rows are left out.
 *   --empty-storage  storage program addresses whose data is set to null
 *                    and sizeBytes to 0; owner, ACL and history are kept.
 * Every listed address must be in the source snapshot.
 */

import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { osDenominationApplied } from "../../src/libs/blockchain/genesis/carryover"
import { compareCodeUnits } from "../../src/libs/crypto/canonicalJson"
import {
    readFileSinglePass,
    verifySnapshot,
    type SnapshotFileEntry,
    type SnapshotManifest,
} from "../../src/libs/blockchain/genesis/verifySnapshot"

export type LaunchValidatorRow = {
    address: string
    status: string
    connection_url: string | null
    staked_amount: string
    first_seen: number
    valid_at: number
    unstake_requested_at: null
    unstake_available_at: null
}

export type CarryoverResult = {
    outDir: string
    manifestSha256: string
    sourceManifestSha256: string
    accounts: number
    zeroedAccounts: number
    validators: number
    zeroPoints: ListSummary & { points: number } | null
    dropStorage: ListSummary | null
    emptyStorage: ListSummary | null
}

/** A declared input list as the manifest records it. */
export type ListSummary = { sha256: string; count: number }

export type AddressList = { addresses: string[]; sha256: string }

export const ACCOUNT_ADDRESS_RE = /^0x[0-9a-f]{64}$/
export const STORAGE_ADDRESS_RE = /^stor-[0-9a-f]{40}$/

const STORAGE_FILE = "gcr_storageprogram.jsonl"
const COPIED_FILES = [STORAGE_FILE, "identity_commitments.jsonl"] as const

const sha256 = (bytes: Buffer | string): string =>
    createHash("sha256").update(bytes).digest("hex")

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === "object" && x !== null && !Array.isArray(x)
}

/**
 * Validates the launch list and returns it as validators.jsonl rows, sorted
 * by address so the file does not depend on the order the list was typed in.
 */
export function launchValidatorRows(list: unknown): LaunchValidatorRow[] {
    const entries = isRecord(list) ? list.validators : list
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error(
            "launch list: expected a non-empty validators array (a genesis file or a bare array)",
        )
    }
    const seen = new Set<string>()
    const rows = entries.map((v, i): LaunchValidatorRow => {
        const where = `launch list entry ${i}`
        if (!isRecord(v)) throw new Error(`${where}: not an object`)
        const { address, status } = v
        const connectionUrl = v.connection_url
        const stakedAmount = v.staked_amount
        const firstSeen = v.first_seen
        const validAt = v.valid_at
        if (typeof address !== "string" || !/^0x[0-9a-f]{64}$/.test(address)) {
            throw new Error(`${where}: address must be lowercase 0x + 64 hex`)
        }
        for (const name of ["unstake_requested_at", "unstake_available_at"] as const) {
            if (v[name] !== undefined && v[name] !== null) {
                throw new Error(`${where} (${address}): ${name} must be null for a launch validator`)
            }
        }
        if (seen.has(address)) throw new Error(`${where}: ${address} listed twice`)
        seen.add(address)
        if (typeof status !== "string" || status === "") {
            throw new Error(`${where} (${address}): status must be a string`)
        }
        if (connectionUrl !== null && (typeof connectionUrl !== "string" || connectionUrl === "")) {
            throw new Error(`${where} (${address}): connection_url must be null or a non-empty string`)
        }
        if (typeof stakedAmount !== "string" || !/^[1-9]\d*$/.test(stakedAmount)) {
            throw new Error(`${where} (${address}): staked_amount must be a positive decimal string`)
        }
        for (const [name, value] of [["first_seen", firstSeen], ["valid_at", validAt]] as const) {
            if (!Number.isSafeInteger(value) || (value as number) < 0) {
                throw new Error(`${where} (${address}): ${name} must be a non-negative integer`)
            }
        }
        // Field order matches the exporter's validators.jsonl.
        return {
            address,
            status,
            connection_url: connectionUrl as string | null,
            staked_amount: stakedAmount,
            first_seen: firstSeen as number,
            valid_at: validAt as number,
            unstake_requested_at: null,
            unstake_available_at: null,
        }
    })
    return rows.sort((a, b) => compareCodeUnits(a.address, b.address))
}

/**
 * Reads a declared address list. Only one spelling of a given set is
 * accepted (sorted, no repeats, one lowercase address per line, final
 * newline), so the sha256 in the manifest identifies the set and not the
 * way someone happened to type it.
 */
export function parseAddressList(bytes: Buffer, pattern: RegExp, label: string): AddressList {
    const text = bytes.toString("utf8")
    const format = "one address per line, sorted without repeats (LC_ALL=C sort -u), ending with a newline"
    if (text === "") throw new Error(`${label}: the list is empty`)
    if (!text.endsWith("\n")) throw new Error(`${label}: no newline at the end; expected ${format}`)
    const addresses = text.slice(0, -1).split("\n")
    addresses.forEach((address, i) => {
        if (!pattern.test(address)) {
            throw new Error(
                `${label} line ${i + 1}: ${JSON.stringify(address)} does not match ${pattern}; expected ${format}`,
            )
        }
        if (i > 0 && compareCodeUnits(addresses[i - 1], address) >= 0) {
            throw new Error(
                `${label} line ${i + 1}: ${address} is ${addresses[i - 1] === address ? "repeated" : "out of order"}; expected ${format}`,
            )
        }
    })
    return { addresses, sha256: sha256(bytes) }
}

function parseCanonicalRow(line: string, file: string, rowNo: number): Record<string, unknown> {
    const row: unknown = JSON.parse(line)
    if (!isRecord(row)) throw new Error(`${file} row ${rowNo}: not an object`)
    if (JSON.stringify(row) !== line) {
        throw new Error(
            `${file} row ${rowNo}: not in canonical JSON form, refusing to rewrite it`,
        )
    }
    return row
}

/**
 * Sets totalPoints and every number in the breakdown to 0 and returns the
 * total removed. The breakdown keeps its keys: the award code reads them as
 * per-source counters and clamps each at 0, so an unlink after the import
 * cannot push an account below 0.
 */
export function zeroPoints(points: unknown, where: string): number {
    if (!isRecord(points) || typeof points.totalPoints !== "number") {
        throw new Error(`${where}: no numeric points.totalPoints`)
    }
    const removed = points.totalPoints
    points.totalPoints = 0
    const zeroNumbers = (value: unknown): unknown => {
        if (typeof value === "number") return 0
        if (Array.isArray(value)) return value.map(zeroNumbers)
        if (isRecord(value)) {
            for (const key of Object.keys(value)) value[key] = zeroNumbers(value[key])
        }
        return value
    }
    if (points.breakdown !== undefined) zeroNumbers(points.breakdown)
    return removed
}

/**
 * One gcr_main line with its balance set to "0", and its points zeroed when
 * asked. Refuses a line that does not survive a parse/serialise round trip
 * unchanged, since rewriting it would then alter more than those fields.
 */
export function carryoverAccountLine(
    line: string,
    rowNo: number,
    zeroPointsOf: ReadonlySet<string> = new Set(),
): { line: string; pubkey: string; balanceZeroed: boolean; pointsRemoved: number | null } {
    const row = parseCanonicalRow(line, "gcr_main.jsonl", rowNo)
    if (typeof row.balance !== "string") {
        throw new Error(`gcr_main.jsonl row ${rowNo}: no string balance`)
    }
    const pubkey = String(row.pubkey)
    const balanceZeroed = row.balance !== "0"
    row.balance = "0"
    const pointsRemoved = zeroPointsOf.has(pubkey)
        ? zeroPoints(row.points, `gcr_main.jsonl row ${rowNo} (${pubkey})`)
        : null
    return { line: JSON.stringify(row), pubkey, balanceZeroed, pointsRemoved }
}

export function zeroBalanceLine(line: string, rowNo: number): string {
    return carryoverAccountLine(line, rowNo).line
}

/**
 * gcr_storageprogram.jsonl with the listed programs left out or emptied.
 * An emptied program looks like one created without data: data null and
 * sizeBytes 0, which the node's own create path writes.
 */
export function filterStoragePrograms(
    text: string,
    drop: ReadonlySet<string>,
    empty: ReadonlySet<string>,
): { text: string; dropped: number; emptied: number; seen: Set<string> } {
    const lines = text.split("\n")
    const trailingNewline = lines[lines.length - 1] === ""
    if (trailingNewline) lines.pop()
    const seen = new Set<string>()
    let dropped = 0
    let emptied = 0
    const out: string[] = []
    lines.forEach((line, i) => {
        if (line.trim() === "") {
            out.push(line)
            return
        }
        const row = JSON.parse(line) as unknown
        const address = isRecord(row) ? row.storageAddress : undefined
        if (typeof address !== "string") {
            throw new Error(`${STORAGE_FILE} row ${i + 1}: no string storageAddress`)
        }
        if (!drop.has(address) && !empty.has(address)) {
            out.push(line)
            return
        }
        seen.add(address)
        if (drop.has(address)) {
            dropped++
            return
        }
        const canonical = parseCanonicalRow(line, STORAGE_FILE, i + 1)
        canonical.data = null
        canonical.sizeBytes = 0
        emptied++
        out.push(JSON.stringify(canonical))
    })
    const body = out.join("\n")
    return { text: body + (trailingNewline && out.length > 0 ? "\n" : ""), dropped, emptied, seen }
}

function missingFromSnapshot(list: AddressList, present: ReadonlySet<string>, label: string, file: string): void {
    const missing = list.addresses.filter(a => !present.has(a))
    if (missing.length > 0) {
        throw new Error(
            `${label}: ${missing.length} listed addresses are not in ${file} ` +
                `(first: ${missing.slice(0, 3).join(", ")}); the list was not built from this snapshot`,
        )
    }
}

async function readList(path: string | undefined, pattern: RegExp, label: string): Promise<AddressList | null> {
    if (path === undefined) return null
    return parseAddressList(await readFile(resolve(path)), pattern, label)
}

async function assertEmptyDir(dir: string): Promise<void> {
    const existing = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return []
        throw e
    })
    if (existing.length > 0) {
        throw new Error(`output directory ${dir} is not empty`)
    }
}

async function fileEntry(
    path: string,
    sumField?: "balance" | "sizeBytes",
): Promise<SnapshotFileEntry> {
    const stats = await readFileSinglePass(path, sumField)
    if (stats.parseError) throw stats.parseError
    const entry: SnapshotFileEntry = { sha256: stats.sha256, rows: stats.rows }
    if (sumField === "balance") entry.balance_sum = (stats.balanceSum ?? 0n).toString()
    if (sumField === "sizeBytes") entry.size_bytes_sum = stats.sizeBytesSum ?? 0
    return entry
}

export async function buildCarryoverSnapshot(opts: {
    inDir: string
    validatorsFile: string
    outDir: string
    /** Account addresses whose points are zeroed. */
    zeroPointsFile?: string
    /** Storage program addresses whose rows are left out. */
    dropStorageFile?: string
    /** Storage program addresses whose data is emptied. */
    emptyStorageFile?: string
}): Promise<CarryoverResult> {
    const inDir = resolve(opts.inDir)
    const outDir = resolve(opts.outDir)
    if (inDir === outDir) throw new Error("--in and --out must differ")

    const source = await verifySnapshot(inDir)
    if (!osDenominationApplied(source)) {
        throw new Error(
            "source snapshot fork_state does not record osDenomination as applied: " +
                "launch stakes are in OS units and block 0 would multiply them by 10^9",
        )
    }
    const sourceManifestBytes = await readFile(resolve(inDir, "manifest.json"))
    const launchListBytes = await readFile(resolve(opts.validatorsFile))
    const validators = launchValidatorRows(JSON.parse(launchListBytes.toString("utf8")))
    const zeroList = await readList(opts.zeroPointsFile, ACCOUNT_ADDRESS_RE, "--zero-points")
    const dropList = await readList(opts.dropStorageFile, STORAGE_ADDRESS_RE, "--drop-storage")
    const emptyList = await readList(opts.emptyStorageFile, STORAGE_ADDRESS_RE, "--empty-storage")
    if (dropList && emptyList) {
        const drop = new Set(dropList.addresses)
        const both = emptyList.addresses.filter(a => drop.has(a))
        if (both.length > 0) {
            throw new Error(
                `--drop-storage and --empty-storage both list ${both.length} programs (first: ${both[0]}); a program is either dropped or emptied`,
            )
        }
    }

    await assertEmptyDir(outDir)
    await mkdir(outDir, { recursive: true })

    const raw = await readFile(resolve(inDir, "gcr_main.jsonl"), "utf8")
    const lines = raw.split("\n")
    const trailingNewline = lines[lines.length - 1] === ""
    if (trailingNewline) lines.pop()
    let accounts = 0
    let zeroedAccounts = 0
    let pointsRemoved = 0
    const zeroSet = new Set(zeroList?.addresses ?? [])
    const pubkeys = new Set<string>()
    const out = lines.map((line, i) => {
        if (line.trim() === "") return line
        accounts++
        const r = carryoverAccountLine(line, i + 1, zeroSet)
        pubkeys.add(r.pubkey)
        if (r.pointsRemoved !== null) pointsRemoved += r.pointsRemoved
        if (r.balanceZeroed) zeroedAccounts++
        return r.line
    })
    if (zeroList) missingFromSnapshot(zeroList, pubkeys, "--zero-points", "gcr_main.jsonl")
    // Awards come in halves (a Web3 wallet link is 0.5), which add up exactly
    // in a double; only a non-finite or out-of-range total is refused.
    if (!Number.isFinite(pointsRemoved) || pointsRemoved < 0 || pointsRemoved > Number.MAX_SAFE_INTEGER) {
        throw new Error(`--zero-points: the points removed (${pointsRemoved}) are not a finite total in range`)
    }

    let storageText: string | null = null
    let storageCounts = { dropped: 0, emptied: 0 }
    if (dropList || emptyList) {
        const filtered = filterStoragePrograms(
            await readFile(resolve(inDir, STORAGE_FILE), "utf8"),
            new Set(dropList?.addresses ?? []),
            new Set(emptyList?.addresses ?? []),
        )
        if (dropList) missingFromSnapshot(dropList, filtered.seen, "--drop-storage", STORAGE_FILE)
        if (emptyList) missingFromSnapshot(emptyList, filtered.seen, "--empty-storage", STORAGE_FILE)
        storageText = filtered.text
        storageCounts = { dropped: filtered.dropped, emptied: filtered.emptied }
    }

    await writeFile(
        resolve(outDir, "gcr_main.jsonl"),
        out.join("\n") + (trailingNewline ? "\n" : ""),
    )

    await writeFile(
        resolve(outDir, "validators.jsonl"),
        validators.map(v => JSON.stringify(v)).join("\n") + "\n",
    )

    for (const name of COPIED_FILES) {
        if (name === STORAGE_FILE && storageText !== null) {
            await writeFile(resolve(outDir, name), storageText)
        } else {
            await copyFile(resolve(inDir, name), resolve(outDir, name))
        }
    }

    const manifest = JSON.parse(sourceManifestBytes.toString("utf8")) as SnapshotManifest & {
        transforms_applied: Record<string, unknown>
        carryover?: Record<string, unknown>
    }
    const files = manifest.files as Record<string, SnapshotFileEntry>
    files["gcr_main.jsonl"] = await fileEntry(resolve(outDir, "gcr_main.jsonl"), "balance")
    files["validators.jsonl"] = await fileEntry(resolve(outDir, "validators.jsonl"))
    for (const name of COPIED_FILES) {
        const written = await fileEntry(resolve(outDir, name), name === STORAGE_FILE ? "sizeBytes" : undefined)
        if (name === STORAGE_FILE && storageText !== null) {
            files[name] = written
        } else if (written.sha256 !== source.files[name].sha256) {
            throw new Error(`${name}: copy does not match the source manifest`)
        }
    }
    // Flags and list entries appear only when a list was given, so a build
    // without lists keeps the manifest it always had.
    manifest.transforms_applied = {
        ...manifest.transforms_applied,
        balances_zeroed: true,
        validators_from_launch_list: true,
        ...(zeroList ? { points_zeroed_from_list: true } : {}),
        ...(dropList ? { storage_programs_dropped_from_list: true } : {}),
        ...(emptyList ? { storage_program_data_emptied_from_list: true } : {}),
    }
    const zeroPointsSummary = zeroList
        ? { sha256: zeroList.sha256, count: zeroList.addresses.length, points: pointsRemoved }
        : null
    const dropSummary = dropList ? { sha256: dropList.sha256, count: storageCounts.dropped } : null
    const emptySummary = emptyList ? { sha256: emptyList.sha256, count: storageCounts.emptied } : null
    manifest.carryover = {
        source_manifest_sha256: sha256(sourceManifestBytes),
        ...(zeroPointsSummary
            ? {
                  zero_points: {
                      list_sha256: zeroPointsSummary.sha256,
                      accounts: zeroPointsSummary.count,
                      points_removed: zeroPointsSummary.points,
                  },
              }
            : {}),
        ...(dropSummary ? { drop_storage: { list_sha256: dropSummary.sha256, programs: dropSummary.count } } : {}),
        ...(emptySummary ? { empty_storage: { list_sha256: emptySummary.sha256, programs: emptySummary.count } } : {}),
    }
    const manifestText = JSON.stringify(manifest, null, 2) + "\n"
    await writeFile(resolve(outDir, "manifest.json"), manifestText)

    const verified = await verifySnapshot(outDir)
    if (verified.files["gcr_main.jsonl"].balance_sum !== "0") {
        throw new Error("self-check: balance_sum of the written snapshot is not 0")
    }

    return {
        outDir,
        manifestSha256: sha256(manifestText),
        sourceManifestSha256: sha256(sourceManifestBytes),
        accounts,
        zeroedAccounts,
        validators: validators.length,
        zeroPoints: zeroPointsSummary,
        dropStorage: dropSummary,
        emptyStorage: emptySummary,
    }
}

export const USAGE =
    "usage: bun scripts/state-snapshot/carryover.ts --in <snapshot dir> --validators <genesis or launch list JSON> " +
    "--out <empty dir> [--zero-points <list>] [--drop-storage <list>] [--empty-storage <list>]"

const FLAGS = ["in", "validators", "out", "zero-points", "drop-storage", "empty-storage"] as const
type Flag = (typeof FLAGS)[number]

/**
 * Refuses anything it does not know: the output is bound into the genesis,
 * so a mistyped option that is silently ignored would seal a snapshot
 * without the change it was meant to carry.
 */
export function parseFlags(argv: string[]): Partial<Record<Flag, string>> {
    const flags: Partial<Record<Flag, string>> = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`)
        const name = arg.slice(2) as Flag
        if (!FLAGS.includes(name)) throw new Error(`unknown option ${arg}`)
        if (flags[name] !== undefined) throw new Error(`${arg} given twice`)
        const value = argv[i + 1]
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`${arg} needs a value`)
        }
        flags[name] = value
        i++
    }
    if (!flags.in || !flags.validators || !flags.out) throw new Error(USAGE)
    return flags
}

async function main(): Promise<void> {
    const flags = parseFlags(process.argv.slice(2))
    const r = await buildCarryoverSnapshot({
        inDir: flags.in as string,
        validatorsFile: flags.validators as string,
        outDir: flags.out as string,
        zeroPointsFile: flags["zero-points"],
        dropStorageFile: flags["drop-storage"],
        emptyStorageFile: flags["empty-storage"],
    })
    console.log(`source manifest sha256   ${r.sourceManifestSha256}`)
    console.log(`accounts                 ${r.accounts} (${r.zeroedAccounts} balances zeroed)`)
    if (r.zeroPoints) {
        console.log(
            `points zeroed            ${r.zeroPoints.count} accounts, ${r.zeroPoints.points} points (list sha256 ${r.zeroPoints.sha256})`,
        )
    }
    if (r.dropStorage) {
        console.log(`storage programs dropped ${r.dropStorage.count} (list sha256 ${r.dropStorage.sha256})`)
    }
    if (r.emptyStorage) {
        console.log(`storage programs emptied ${r.emptyStorage.count} (list sha256 ${r.emptyStorage.sha256})`)
    }
    console.log(`launch validators        ${r.validators}`)
    console.log(`carryover manifest sha256 ${r.manifestSha256}`)
    console.log(`written to ${r.outDir}`)
}

if (import.meta.main) {
    try {
        await main()
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
    }
}
