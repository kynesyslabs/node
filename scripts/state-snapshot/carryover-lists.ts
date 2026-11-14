/* eslint-disable no-console */
/**
 * Builds the address lists that scripts/state-snapshot/carryover.ts takes,
 * from a source snapshot, in the one form it accepts (sorted, no repeats,
 * one address per line). Anyone can rerun it on the same snapshot and get
 * the same bytes, so the list's sha256 in the carry-over manifest can be
 * checked against its definition.
 *
 *   bun scripts/state-snapshot/carryover-lists.ts referees --in data/snapshot \
 *       --root 0x<64 hex> [--root ...] [--out FILE]
 *     Accounts referred directly by any root (their referralInfo.referredBy),
 *     for --zero-points. The roots themselves are not listed.
 *
 *   bun scripts/state-snapshot/carryover-lists.ts non-public-storage --in data/snapshot [--out FILE]
 *     Storage programs whose ACL mode is not "public", for --drop-storage or
 *     --empty-storage.
 *
 * The list goes to --out (or stdout); counts and the sha256 go to stderr.
 */

import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { compareCodeUnits } from "../../src/libs/crypto/canonicalJson"
import { ACCOUNT_ADDRESS_RE } from "./carryover"

type Row = Record<string, unknown>

function isRecord(x: unknown): x is Row {
    return typeof x === "object" && x !== null && !Array.isArray(x)
}

export function parseJsonl(text: string, file: string): Row[] {
    return text
        .split("\n")
        .filter(line => line.trim() !== "")
        .map((line, i) => {
            const row: unknown = JSON.parse(line)
            if (!isRecord(row)) throw new Error(`${file} row ${i + 1}: not an object`)
            return row
        })
}

/** The bytes carryover.ts accepts for this set of addresses. */
export function listText(addresses: Iterable<string>): string {
    const sorted = [...new Set(addresses)].sort(compareCodeUnits)
    return sorted.length === 0 ? "" : sorted.join("\n") + "\n"
}

export type RefereeList = {
    addresses: string[]
    points: number
    flagged: number
}

/**
 * Accounts whose referredBy is one of the roots. Each root's own referrals
 * array must name exactly the same accounts: if the two records disagree,
 * "referee of this root" has two answers and the list would depend on
 * which one was read.
 */
export function refereesOf(rows: Row[], roots: string[]): RefereeList {
    if (roots.length === 0) throw new Error("give at least one --root")
    const byKey = new Map(rows.map(r => [String(r.pubkey), r]))
    const fromReferredBy = new Map<string, Set<string>>(roots.map(root => [root, new Set()]))
    for (const root of roots) {
        if (!ACCOUNT_ADDRESS_RE.test(root)) throw new Error(`root ${root} is not lowercase 0x + 64 hex`)
        if (!byKey.has(root)) throw new Error(`root ${root} is not in gcr_main.jsonl`)
    }
    for (const row of rows) {
        const info = row.referralInfo
        const by = isRecord(info) ? info.referredBy : null
        if (typeof by === "string" && fromReferredBy.has(by)) fromReferredBy.get(by)!.add(String(row.pubkey))
    }
    const out = new Set<string>()
    for (const root of roots) {
        const info = byKey.get(root)!.referralInfo
        const listed = new Set(
            (isRecord(info) && Array.isArray(info.referrals) ? info.referrals : [])
                .map(x => (isRecord(x) ? x.referredUserId : undefined))
                .filter((x): x is string => typeof x === "string"),
        )
        const referred = fromReferredBy.get(root)!
        const onlyListed = [...listed].filter(a => !referred.has(a))
        const onlyReferred = [...referred].filter(a => !listed.has(a))
        if (onlyListed.length > 0 || onlyReferred.length > 0) {
            throw new Error(
                `root ${root}: its referrals array and the referredBy fields disagree ` +
                    `(${onlyListed.length} only in the array, ${onlyReferred.length} only in referredBy)`,
            )
        }
        for (const a of referred) out.add(a)
    }
    const addresses = [...out].sort(compareCodeUnits)
    let points = 0
    let flagged = 0
    for (const a of addresses) {
        const row = byKey.get(a)!
        const p = isRecord(row.points) ? row.points.totalPoints : 0
        points += typeof p === "number" ? p : 0
        if (row.flagged === true) flagged++
    }
    return { addresses, points, flagged }
}

/** Storage programs whose ACL mode is anything but "public". */
export function nonPublicStoragePrograms(rows: Row[]): { addresses: string[]; byMode: Record<string, number> } {
    const addresses: string[] = []
    const byMode: Record<string, number> = {}
    for (const row of rows) {
        const mode = isRecord(row.acl) ? row.acl.mode : undefined
        if (mode === "public") continue
        const key = String(mode)
        byMode[key] = (byMode[key] ?? 0) + 1
        addresses.push(String(row.storageAddress))
    }
    return { addresses: addresses.sort(compareCodeUnits), byMode }
}

type Args = { command: string; in: string; roots: string[]; out: string | null }

export function parseArgs(argv: string[]): Args {
    const [command, ...rest] = argv
    if (command !== "referees" && command !== "non-public-storage") {
        throw new Error("usage: carryover-lists.ts referees|non-public-storage --in DIR [--root ADDR ...] [--out FILE]")
    }
    const args: Args = { command, in: "", roots: [], out: null }
    for (let i = 0; i < rest.length; i++) {
        const value = rest[i + 1]
        if (value === undefined || value.startsWith("--")) throw new Error(`${rest[i]} needs a value`)
        switch (rest[i]) {
            case "--in": args.in = value; break
            case "--root":
                if (command !== "referees") throw new Error("--root applies to referees only")
                args.roots.push(value)
                break
            case "--out": args.out = value; break
            default: throw new Error(`unknown option ${rest[i]}`)
        }
        i++
    }
    if (!args.in) throw new Error("--in is required")
    return args
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    let text: string
    if (args.command === "referees") {
        const file = resolve(args.in, "gcr_main.jsonl")
        const r = refereesOf(parseJsonl(await readFile(file, "utf8"), "gcr_main.jsonl"), args.roots)
        text = listText(r.addresses)
        console.error(`accounts ${r.addresses.length}, points ${r.points}, flagged ${r.flagged}`)
    } else {
        const file = resolve(args.in, "gcr_storageprogram.jsonl")
        const r = nonPublicStoragePrograms(parseJsonl(await readFile(file, "utf8"), "gcr_storageprogram.jsonl"))
        text = listText(r.addresses)
        console.error(`programs ${r.addresses.length} ${JSON.stringify(r.byMode)}`)
    }
    console.error(`list sha256 ${createHash("sha256").update(text).digest("hex")}`)
    if (args.out) await writeFile(resolve(args.out), text)
    else process.stdout.write(text)
}

if (import.meta.main) {
    try {
        await main()
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
    }
}
