/**
 * The declared lists of the carry-over builder: points zeroed for listed
 * accounts, storage programs dropped or emptied, and the list builder that
 * derives them from a snapshot. Each list is bound into the manifest, which
 * the genesis binds, so these tests check what reaches the manifest as well
 * as the rows.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    buildCarryoverSnapshot,
    parseAddressList,
    parseFlags,
    zeroPoints,
    ACCOUNT_ADDRESS_RE,
    STORAGE_ADDRESS_RE,
} from "../../scripts/state-snapshot/carryover"
import {
    listText,
    nonPublicStoragePrograms,
    parseArgs as parseListArgs,
    refereesOf,
} from "../../scripts/state-snapshot/carryover-lists"
import { carryoverSnapshotProblems } from "@/libs/blockchain/genesis/carryover"
import { loadSnapshot, type SnapshotLoaderAvailable } from "@/libs/blockchain/genesis/loadSnapshot"

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex")
const hex64 = (seed: string) => "0x" + sha256(seed)
const stor = (seed: string) => "stor-" + sha256(seed).slice(0, 40)

const ROOT = hex64("root")
const FARM_1 = hex64("farm-1")
const FARM_2 = hex64("farm-2")
const HONEST = hex64("honest")

function points(total: number) {
    return {
        breakdown: {
            referrals: total > 0 ? 1 : 0,
            web3Wallets: { evm: total > 1 ? total - 1 : 0 },
            socialAccounts: { github: 0, twitter: 0 },
            weeklyChallenge: [{ date: "2026-01-05T00:00:00.000Z", points: 0 }],
        },
        lastUpdated: "2026-01-01T00:00:00.000Z",
        totalPoints: total,
    }
}

function account(pubkey: string, total: number, referredBy: string | null, referrals: string[] = []) {
    return {
        pubkey,
        assignedTxs: [],
        nonce: 0,
        balance: "5",
        identities: { xm: {}, web2: {} },
        points: points(total),
        referralInfo: {
            referrals: referrals.map(id => ({ referredUserId: id, pointsAwarded: 3 })),
            referredBy,
            referralCode: pubkey.slice(2, 10),
            totalReferrals: referrals.length,
        },
        flagged: referredBy === ROOT,
        flaggedReason: "",
        reviewed: false,
        createdAt: "2026-01-01 00:00:00",
        updatedAt: "2026-01-01 00:00:00",
    }
}

const ACCOUNTS = [
    account(ROOT, 9, null, [FARM_1, FARM_2]),
    account(FARM_1, 4, ROOT),
    account(FARM_2, 7, ROOT),
    account(HONEST, 11, null),
].sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1))

function program(address: string, mode: string, data: unknown) {
    return {
        storageAddress: address,
        owner: HONEST,
        programName: address,
        encoding: "json",
        data,
        sizeBytes: JSON.stringify(data).length,
        acl: { mode },
        metadata: null,
        storageLocation: "onchain",
        ipfsCid: null,
        salt: null,
        createdByTx: "tx",
        lastModifiedByTx: "tx",
        totalFeesPaid: "1",
        isDeleted: false,
        interactionTxs: "tx",
        deletedByTx: null,
        createdAt: "2026-01-01 00:00:00",
        updatedAt: "2026-01-01 00:00:00",
    }
}

const PUBLIC = stor("public")
const OWNER = stor("owner")
const RESTRICTED = stor("restricted")
const PROGRAMS = [
    program(PUBLIC, "public", { a: 1 }),
    program(OWNER, "owner", { secret: "x" }),
    program(RESTRICTED, "restricted", { secret: "y" }),
]

const LAUNCH = [
    { address: hex64("launch"), status: "2", connection_url: "https://a.example.invalid", staked_amount: "1000", first_seen: 0, valid_at: 0 },
]

const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")

async function writeSnapshot(dir: string, accounts = ACCOUNTS): Promise<void> {
    await mkdir(dir, { recursive: true })
    const gcr = jsonl(accounts)
    const storage = jsonl(PROGRAMS)
    const validators = jsonl([{ ...LAUNCH[0], address: hex64("old"), unstake_requested_at: null, unstake_available_at: null }])
    const manifest = {
        schemaVersion: 2,
        source: { host: "test", chain_block_height: 1, chain_block_hash: "00".repeat(32), node_version: "t", pg_version: "16", dumped_at: "2026-01-01T00:00:00Z" },
        files: {
            "gcr_main.jsonl": { sha256: sha256(gcr), rows: accounts.length, balance_sum: String(5 * accounts.length) },
            "gcr_storageprogram.jsonl": {
                sha256: sha256(storage),
                rows: PROGRAMS.length,
                size_bytes_sum: PROGRAMS.reduce((a, p) => a + p.sizeBytes, 0),
            },
            "identity_commitments.jsonl": { sha256: sha256(""), rows: 0 },
            "validators.jsonl": { sha256: sha256(validators), rows: 1 },
        },
        fork_state: [{ fork_name: "osDenomination", applied: true }],
        transforms_applied: { nonces_reset_to_zero: true },
    }
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    await writeFile(join(dir, "gcr_main.jsonl"), gcr)
    await writeFile(join(dir, "gcr_storageprogram.jsonl"), storage)
    await writeFile(join(dir, "identity_commitments.jsonl"), "")
    await writeFile(join(dir, "validators.jsonl"), validators)
}

async function load(dir: string): Promise<SnapshotLoaderAvailable> {
    const prev = process.env.DEMOS_SNAPSHOT_DIR
    process.env.DEMOS_SNAPSHOT_DIR = dir
    try {
        const loader = await loadSnapshot()
        if (!loader.available) throw new Error("snapshot not available")
        return loader
    } finally {
        if (prev === undefined) delete process.env.DEMOS_SNAPSHOT_DIR
        else process.env.DEMOS_SNAPSHOT_DIR = prev
    }
}

const readRows = async (file: string) =>
    (await readFile(file, "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l))

let work: string
let source: string
let launchFile: string

async function list(name: string, addresses: string[]): Promise<string> {
    const file = join(work, name)
    await writeFile(file, listText(addresses))
    return file
}

beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "carryover-lists-"))
    source = join(work, "source")
    await writeSnapshot(source)
    launchFile = join(work, "launch.json")
    await writeFile(launchFile, JSON.stringify(LAUNCH))
})

afterEach(async () => {
    await rm(work, { recursive: true, force: true })
})

describe("carry-over command line", () => {
    const base = ["--in", "a", "--validators", "b", "--out", "c"]

    it("refuses an unknown or repeated option instead of ignoring it", () => {
        expect(() => parseFlags([...base, "--exclude", "x"])).toThrow("unknown option --exclude")
        expect(() => parseFlags([...base, "--zero-point", "x"])).toThrow("unknown option")
        expect(() => parseFlags([...base, "--in", "d"])).toThrow("given twice")
        expect(() => parseFlags([...base, "--zero-points"])).toThrow("needs a value")
        expect(() => parseFlags(["--in", "a", "--out", "c"])).toThrow("usage")
        expect(() => parseFlags([...base, "stray"])).toThrow("unexpected argument")
    })

    it("takes the three lists", () => {
        expect(
            parseFlags([...base, "--zero-points", "z", "--drop-storage", "d", "--empty-storage", "e"]),
        ).toEqual({ in: "a", validators: "b", out: "c", "zero-points": "z", "drop-storage": "d", "empty-storage": "e" })
    })
})

describe("address lists", () => {
    const parse = (text: string, re = ACCOUNT_ADDRESS_RE) => parseAddressList(Buffer.from(text), re, "--zero-points")

    it("accepts only the sorted, unique, newline-terminated form, and hashes its bytes", () => {
        const text = listText([FARM_2, FARM_1])
        const parsed = parse(text)
        expect(parsed.addresses).toEqual([FARM_1, FARM_2].sort())
        expect(parsed.sha256).toBe(sha256(text))
        const [lo, hi] = [FARM_1, FARM_2].sort()
        expect(() => parse("")).toThrow("empty")
        expect(() => parse(`${lo}\n${hi}`)).toThrow("no newline at the end")
        expect(() => parse(`${hi}\n${lo}\n`)).toThrow("out of order")
        expect(() => parse(`${lo}\n${lo}\n`)).toThrow("repeated")
        expect(() => parse(`${lo.toUpperCase().replace("0X", "0x")}\n`)).toThrow("does not match")
        expect(() => parse(`${lo}\r\n`)).toThrow("does not match")
        expect(() => parse(`${lo}\n\n`)).toThrow("line 2")
        expect(() => parse(`${PUBLIC}\n`)).toThrow("does not match")
        expect(parse(`${PUBLIC}\n`, STORAGE_ADDRESS_RE).addresses).toEqual([PUBLIC])
    })
})

describe("--zero-points", () => {
    it("zeroes totalPoints and every number in the breakdown, keeping its keys", () => {
        const p = points(7)
        p.breakdown.weeklyChallenge[0].points = 20
        expect(zeroPoints(p, "row")).toBe(7)
        expect(p).toEqual({
            breakdown: {
                referrals: 0,
                web3Wallets: { evm: 0 },
                socialAccounts: { github: 0, twitter: 0 },
                weeklyChallenge: [{ date: "2026-01-05T00:00:00.000Z", points: 0 }],
            },
            lastUpdated: "2026-01-01T00:00:00.000Z",
            totalPoints: 0,
        })
        expect(() => zeroPoints({}, "row 3")).toThrow("row 3: no numeric points.totalPoints")
    })

    it("zeroes the listed accounts only and records the list in the manifest", async () => {
        const zeroFile = await list("group-a.txt", [FARM_1, FARM_2])
        const out = join(work, "out")
        const r = await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out, zeroPointsFile: zeroFile })
        expect(r.zeroPoints).toEqual({ sha256: sha256(await readFile(zeroFile)), count: 2, points: 11 })

        const rows = await readRows(join(out, "gcr_main.jsonl"))
        for (const [i, row] of rows.entries()) {
            const before = ACCOUNTS[i]
            expect(row.balance).toBe("0")
            if (row.pubkey === FARM_1 || row.pubkey === FARM_2) {
                expect(row.points.totalPoints).toBe(0)
                expect(row.points.lastUpdated).toBe(before.points.lastUpdated)
                expect({ ...row, points: null }).toEqual({ ...before, balance: "0", points: null })
            } else {
                expect(row).toEqual({ ...before, balance: "0" })
            }
        }

        const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))
        expect(manifest.carryover.zero_points).toEqual({ list_sha256: r.zeroPoints!.sha256, accounts: 2, points_removed: 11 })
        expect(manifest.transforms_applied.points_zeroed_from_list).toBe(true)
        expect(await carryoverSnapshotProblems(await load(out), LAUNCH)).toEqual([])
    })

    it("zeroes accounts whose points come in halves", async () => {
        const halves = ACCOUNTS.map(a => (a.pubkey === FARM_1 ? account(FARM_1, 4.5, ROOT) : a))
        const halfSource = join(work, "halves")
        await writeSnapshot(halfSource, halves)
        const zeroFile = await list("group-a.txt", [FARM_1, FARM_2])
        const out = join(work, "out")
        const r = await buildCarryoverSnapshot({ inDir: halfSource, validatorsFile: launchFile, outDir: out, zeroPointsFile: zeroFile })
        expect(r.zeroPoints!.points).toBe(11.5)
        const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))
        expect(manifest.carryover.zero_points.points_removed).toBe(11.5)
    })

    it("leaves the manifest as it was without a list", async () => {
        const out = join(work, "out")
        const r = await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out })
        expect(r.zeroPoints).toBeNull()
        const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))
        expect(Object.keys(manifest.carryover)).toEqual(["source_manifest_sha256"])
        expect(Object.keys(manifest.transforms_applied)).toEqual([
            "nonces_reset_to_zero", "balances_zeroed", "validators_from_launch_list",
        ])
    })

    it("refuses an address that is not in the snapshot and writes nothing it vouches for", async () => {
        const zeroFile = await list("typo.txt", [FARM_1, hex64("nobody")])
        const out = join(work, "out")
        await expect(
            buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out, zeroPointsFile: zeroFile }),
        ).rejects.toThrow("1 listed addresses are not in gcr_main.jsonl")
        expect(await readdir(out)).not.toContain("manifest.json")
    })

    it("gives a different manifest for a different list, the same for the same list", async () => {
        const a = await buildCarryoverSnapshot({
            inDir: source, validatorsFile: launchFile, outDir: join(work, "a"), zeroPointsFile: await list("a.txt", [FARM_1]),
        })
        const b = await buildCarryoverSnapshot({
            inDir: source, validatorsFile: launchFile, outDir: join(work, "b"), zeroPointsFile: await list("b.txt", [FARM_1]),
        })
        const c = await buildCarryoverSnapshot({
            inDir: source, validatorsFile: launchFile, outDir: join(work, "c"), zeroPointsFile: await list("c.txt", [FARM_1, FARM_2]),
        })
        expect(a.manifestSha256).toBe(b.manifestSha256)
        expect(c.manifestSha256).not.toBe(a.manifestSha256)
    })
})

describe("--drop-storage and --empty-storage", () => {
    it("are off by default: the storage file is copied byte for byte", async () => {
        const out = join(work, "out")
        const r = await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out })
        expect(r.dropStorage).toBeNull()
        expect(r.emptyStorage).toBeNull()
        expect(await readFile(join(out, "gcr_storageprogram.jsonl"))).toEqual(
            await readFile(join(source, "gcr_storageprogram.jsonl")),
        )
    })

    it("drops the listed programs and records the list", async () => {
        const dropFile = await list("drop.txt", [OWNER, RESTRICTED])
        const out = join(work, "out")
        const r = await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out, dropStorageFile: dropFile })
        expect(r.dropStorage).toEqual({ sha256: sha256(await readFile(dropFile)), count: 2 })
        expect(await readRows(join(out, "gcr_storageprogram.jsonl"))).toEqual([PROGRAMS[0]])
        const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))
        expect(manifest.files["gcr_storageprogram.jsonl"].rows).toBe(1)
        expect(manifest.files["gcr_storageprogram.jsonl"].size_bytes_sum).toBe(PROGRAMS[0].sizeBytes)
        expect(manifest.carryover.drop_storage).toEqual({ list_sha256: r.dropStorage!.sha256, programs: 2 })
        expect(manifest.transforms_applied.storage_programs_dropped_from_list).toBe(true)
        expect(await carryoverSnapshotProblems(await load(out), LAUNCH)).toEqual([])
    })

    it("empties the listed programs' data and keeps the rest of the row", async () => {
        const emptyFile = await list("empty.txt", [OWNER])
        const out = join(work, "out")
        const r = await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out, emptyStorageFile: emptyFile })
        expect(r.emptyStorage).toEqual({ sha256: sha256(await readFile(emptyFile)), count: 1 })
        const rows = await readRows(join(out, "gcr_storageprogram.jsonl"))
        expect(rows).toEqual([PROGRAMS[0], { ...PROGRAMS[1], data: null, sizeBytes: 0 }, PROGRAMS[2]])
        const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))
        expect(manifest.files["gcr_storageprogram.jsonl"].rows).toBe(3)
        expect(manifest.carryover.empty_storage).toEqual({ list_sha256: r.emptyStorage!.sha256, programs: 1 })
        expect(manifest.transforms_applied.storage_program_data_emptied_from_list).toBe(true)
        // The loader reads an emptied row as it reads one created without data
        const loader = await load(out)
        const loaded = []
        for await (const p of loader.streamGcrStorageProgram()) loaded.push(p)
        expect(loaded.find(p => p.storageAddress === OWNER)).toMatchObject({ data: null, sizeBytes: 0 })
    })

    it("refuses a program listed in both, or one the snapshot does not hold", async () => {
        await expect(
            buildCarryoverSnapshot({
                inDir: source, validatorsFile: launchFile, outDir: join(work, "o1"),
                dropStorageFile: await list("d.txt", [OWNER]), emptyStorageFile: await list("e.txt", [OWNER, RESTRICTED]),
            }),
        ).rejects.toThrow("a program is either dropped or emptied")
        await expect(
            buildCarryoverSnapshot({
                inDir: source, validatorsFile: launchFile, outDir: join(work, "o2"),
                dropStorageFile: await list("d2.txt", [stor("missing")]),
            }),
        ).rejects.toThrow("not in gcr_storageprogram.jsonl")
    })
})

describe("list builder", () => {
    it("lists the direct referees of the roots with their points", () => {
        const r = refereesOf(ACCOUNTS, [ROOT])
        expect(r).toEqual({ addresses: [FARM_1, FARM_2].sort(), points: 11, flagged: 2 })
        expect(listText(r.addresses)).toBe([FARM_1, FARM_2].sort().join("\n") + "\n")
    })

    it("never lists a root, even one another root referred", () => {
        const ROOT_2 = hex64("root-two")
        const rows = [
            ...ACCOUNTS.map(a => (a.pubkey === ROOT ? account(ROOT, 9, null, [FARM_1, FARM_2, ROOT_2]) : a)),
            account(ROOT_2, 5, ROOT),
        ]
        expect(refereesOf(rows, [ROOT]).addresses).toContain(ROOT_2)
        expect(refereesOf(rows, [ROOT, ROOT_2])).toEqual({ addresses: [FARM_1, FARM_2].sort(), points: 11, flagged: 2 })
    })

    it("refuses a root whose referrals array and referredBy fields disagree, or an unknown root", () => {
        const skewed = ACCOUNTS.map(a => (a.pubkey === ROOT ? account(ROOT, 9, null, [FARM_1]) : a))
        expect(() => refereesOf(skewed, [ROOT])).toThrow("disagree")
        expect(() => refereesOf(ACCOUNTS, [hex64("nobody")])).toThrow("not in gcr_main.jsonl")
        expect(() => refereesOf(ACCOUNTS, [])).toThrow("at least one")
    })

    it("lists the programs whose ACL is not public", () => {
        expect(nonPublicStoragePrograms(PROGRAMS)).toEqual({
            addresses: [OWNER, RESTRICTED].sort(),
            byMode: { owner: 1, restricted: 1 },
        })
    })

    it("refuses unknown options", () => {
        expect(() => parseListArgs(["referees", "--in", "d", "--roots", "x"])).toThrow("unknown option")
        expect(() => parseListArgs(["non-public-storage", "--in", "d", "--root", "x"])).toThrow("referees only")
        expect(() => parseListArgs(["other"])).toThrow("usage")
    })
})
