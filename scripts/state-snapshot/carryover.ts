/* eslint-disable no-console */
/**
 * Builds the snapshot a mainnet genesis imports under `identityCarryover`
 * from a source-network snapshot.
 *
 *   - gcr_main.jsonl: every account row kept, its balance set to "0";
 *     identities, points, referralInfo and every other column untouched.
 *   - validators.jsonl: written from the launch validator list, the source
 *     network's validator rows and stakes are dropped.
 *   - gcr_storageprogram.jsonl, identity_commitments.jsonl: copied byte for
 *     byte.
 *   - manifest.json: the source manifest with the new file entries, two
 *     transform flags and a `carryover` block naming the source manifest
 *     and launch list by sha256.
 *
 * The output is a pure function of the two inputs, so anyone can rebuild it
 * and get the same manifest sha256, which is what the genesis binds.
 *
 * Usage:
 *   bun run snapshot:carryover --in data/snapshot \
 *       --validators mainnet/genesis.json --out mainnet/snapshot
 *
 * --validators takes a genesis file (its `validators` array is used) or a
 * bare JSON array of the same entries: address, status, connection_url
 * (null allowed), staked_amount, first_seen, valid_at.
 */

import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

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
    launchListSha256: string
    accounts: number
    zeroedAccounts: number
    validators: number
}

const COPIED_FILES = [
    "gcr_storageprogram.jsonl",
    "identity_commitments.jsonl",
] as const

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
        if (seen.has(address)) throw new Error(`${where}: ${address} listed twice`)
        seen.add(address)
        if (typeof status !== "string" || status === "") {
            throw new Error(`${where} (${address}): status must be a string`)
        }
        if (connectionUrl !== null && (typeof connectionUrl !== "string" || connectionUrl === "")) {
            throw new Error(`${where} (${address}): connection_url must be null or a non-empty string`)
        }
        if (typeof stakedAmount !== "string" || !/^(0|[1-9][0-9]*)$/.test(stakedAmount)) {
            throw new Error(`${where} (${address}): staked_amount must be a decimal string`)
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
    return rows.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
}

/**
 * One gcr_main line with its balance set to "0". Refuses a line that does
 * not survive a parse/serialise round trip unchanged, since rewriting it
 * would then alter more than the balance.
 */
export function zeroBalanceLine(line: string, rowNo: number): string {
    const row: unknown = JSON.parse(line)
    if (!isRecord(row) || typeof row.balance !== "string") {
        throw new Error(`gcr_main.jsonl row ${rowNo}: no string balance`)
    }
    if (JSON.stringify(row) !== line) {
        throw new Error(
            `gcr_main.jsonl row ${rowNo}: not in canonical JSON form, refusing to rewrite it`,
        )
    }
    row.balance = "0"
    return JSON.stringify(row)
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
}): Promise<CarryoverResult> {
    const inDir = resolve(opts.inDir)
    const outDir = resolve(opts.outDir)
    if (inDir === outDir) throw new Error("--in and --out must differ")

    const source = await verifySnapshot(inDir)
    const sourceManifestBytes = await readFile(resolve(inDir, "manifest.json"))
    const launchListBytes = await readFile(resolve(opts.validatorsFile))
    const validators = launchValidatorRows(JSON.parse(launchListBytes.toString("utf8")))

    await assertEmptyDir(outDir)
    await mkdir(outDir, { recursive: true })

    const raw = await readFile(resolve(inDir, "gcr_main.jsonl"), "utf8")
    const lines = raw.split("\n")
    const trailingNewline = lines[lines.length - 1] === ""
    if (trailingNewline) lines.pop()
    let accounts = 0
    let zeroedAccounts = 0
    const out = lines.map((line, i) => {
        if (line.trim() === "") return line
        accounts++
        const zeroed = zeroBalanceLine(line, i + 1)
        if (zeroed !== line) zeroedAccounts++
        return zeroed
    })
    await writeFile(
        resolve(outDir, "gcr_main.jsonl"),
        out.join("\n") + (trailingNewline ? "\n" : ""),
    )

    await writeFile(
        resolve(outDir, "validators.jsonl"),
        validators.map(v => JSON.stringify(v)).join("\n") + "\n",
    )

    for (const name of COPIED_FILES) {
        await copyFile(resolve(inDir, name), resolve(outDir, name))
    }

    const manifest = JSON.parse(sourceManifestBytes.toString("utf8")) as SnapshotManifest & {
        transforms_applied: Record<string, unknown>
        carryover?: Record<string, unknown>
    }
    const files = manifest.files as Record<string, SnapshotFileEntry>
    files["gcr_main.jsonl"] = await fileEntry(resolve(outDir, "gcr_main.jsonl"), "balance")
    files["validators.jsonl"] = await fileEntry(resolve(outDir, "validators.jsonl"))
    for (const name of COPIED_FILES) {
        if (files[name].sha256 !== source.files[name].sha256) {
            throw new Error(`${name}: copy does not match the source manifest`)
        }
    }
    manifest.transforms_applied = {
        ...manifest.transforms_applied,
        balances_zeroed: true,
        validators_from_launch_list: true,
    }
    manifest.carryover = {
        source_manifest_sha256: sha256(sourceManifestBytes),
        launch_validators_sha256: sha256(launchListBytes),
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
        launchListSha256: sha256(launchListBytes),
        accounts,
        zeroedAccounts,
        validators: validators.length,
    }
}

function parseFlags(argv: string[]): Record<string, string> {
    const flags: Record<string, string> = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`)
        const value = argv[i + 1]
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`${arg} needs a value`)
        }
        flags[arg.slice(2)] = value
        i++
    }
    return flags
}

async function main(): Promise<void> {
    const flags = parseFlags(process.argv.slice(2))
    if (!flags.in || !flags.validators || !flags.out) {
        throw new Error(
            "usage: bun scripts/state-snapshot/carryover.ts --in <snapshot dir> --validators <genesis or launch list JSON> --out <empty dir>",
        )
    }
    const r = await buildCarryoverSnapshot({
        inDir: flags.in,
        validatorsFile: flags.validators,
        outDir: flags.out,
    })
    console.log(`source manifest sha256   ${r.sourceManifestSha256}`)
    console.log(`launch list sha256       ${r.launchListSha256}`)
    console.log(`accounts                 ${r.accounts} (${r.zeroedAccounts} balances zeroed)`)
    console.log(`launch validators        ${r.validators}`)
    console.log(`carryover manifest sha256 ${r.manifestSha256}`)
    console.log(`written to ${r.outDir}`)
}

if (import.meta.main) {
    main().catch(err => {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
    })
}
