/**
 * identityCarryover genesis import: the carry-over snapshot builder
 * (scripts/state-snapshot/carryover.ts), the pre-write refusals and the
 * restore under the fork, against temp snapshot directories and an
 * in-memory EntityManager.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    buildCarryoverSnapshot,
    launchValidatorRows,
    zeroBalanceLine,
} from "../../scripts/state-snapshot/carryover"
import {
    assertCarryoverSnapshot,
    carryoverManifestProblems,
    carryoverSnapshotProblems,
    expectedImportedIdentities,
    firstConnectionKey,
    importedIdentityDigest,
    importedIdentityKeys,
    launchValidatorProblems,
} from "@/libs/blockchain/genesis/carryover"
import { GenesisRefusal, freshGenesisProblems } from "@/libs/blockchain/genesis/genesisPin"
import { restoreGenesisState, type GenesisStateSteps } from "@/libs/blockchain/genesis/restoreGenesisState"
import { importedIdentityProblems } from "@/libs/blockchain/genesis/verifyImportedIdentities"
import { cloneDefaultForkConfig, type ForkConfigByName } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import {
    loadSnapshot,
    openBoundGcrMain,
    type SnapshotLoaderAvailable,
} from "@/libs/blockchain/genesis/loadSnapshot"
import { restoreSnapshot } from "@/libs/blockchain/genesis/restoreSnapshot"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { Validators } from "@/model/entities/Validators"
import { GenesisImportedIdentity } from "@/model/entities/GenesisImportedIdentity"

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex")
const hex64 = (seed: string) => "0x" + sha256(seed)

const ALICE = hex64("alice")
const BOB = hex64("bob")
const CAROL = hex64("carol")

const ALICE_IDENTITIES = {
    web2: {
        twitter: [{ proof: "p", userId: "111", username: "alice", proofHash: "h", timestamp: 1 }],
        github: [{ proof: "p", userId: 222, username: "alice-gh", proofHash: "h", timestamp: 1 }],
        // A stored link without a userId cannot be keyed.
        discord: [{ proof: "p", username: "alice#1", proofHash: "h", timestamp: 1 }],
    },
    xm: {
        evm: { mainnet: [{ address: "0xAbCdEf0000000000000000000000000000000001", signature: "s" }] },
        solana: { mainnet: [{ address: "So1anaAddr", signature: "s" }] },
    },
    nomis: { evm: { mainnet: [{ address: "0xAbCdEf0000000000000000000000000000000001", score: 1 }] } },
    ud: [{ domain: "Alice.crypto", signature: "s" }],
    humanpassport: [{ address: " 0xAAAA ", score: 20 }],
}
const ALICE_POINTS = {
    totalPoints: 42,
    breakdown: { web3Wallets: { evm: 1 }, socialAccounts: { twitter: 2, github: 1 }, referrals: 3 },
    lastUpdated: "2026-10-01T00:00:00.000Z",
}
const ALICE_REFERRAL = { referralCode: "ALICE1", totalReferrals: 1, referrals: [{ referredUserId: BOB }] }

function gcrRow(pubkey: string, balance: string, extra: Record<string, unknown> = {}) {
    return {
        pubkey,
        assignedTxs: [],
        nonce: 0,
        balance,
        identities: {},
        points: {},
        referralInfo: {},
        flagged: false,
        flaggedReason: "",
        reviewed: false,
        createdAt: "2026-01-01 00:00:00",
        updatedAt: "2026-01-01 00:00:00",
        ...extra,
    }
}

const SOURCE_ROWS = [
    gcrRow(ALICE, "5000000000", {
        identities: ALICE_IDENTITIES,
        points: ALICE_POINTS,
        referralInfo: ALICE_REFERRAL,
    }),
    gcrRow(BOB, "0", { identities: { web2: { twitter: [{ userId: "111", username: "alice-again" }] } } }),
    gcrRow(CAROL, "17"),
]

const STORAGE_ROW = {
    storageAddress: "stor-1",
    owner: ALICE,
    programName: "prog",
    encoding: "json",
    data: { k: "v" },
    sizeBytes: 12,
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
}

const OLD_VALIDATOR = {
    address: hex64("testnet-validator"),
    status: "2",
    connection_url: "https://old.example.invalid",
    staked_amount: "999",
    first_seen: 100,
    valid_at: 100,
    unstake_requested_at: null,
    unstake_available_at: null,
}

const LAUNCH = [
    { address: hex64("launch-b"), status: "2", connection_url: "https://b.example.invalid", staked_amount: "1000", first_seen: 0, valid_at: 0 },
    { address: hex64("launch-a"), status: "2", connection_url: null, staked_amount: "1000", first_seen: 0, valid_at: 0 },
]

const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")

async function writeSnapshot(
    dir: string,
    rows: Array<ReturnType<typeof gcrRow>>,
    opts: { balanceSum?: string; validators?: unknown[]; forkState?: unknown[] } = {},
): Promise<void> {
    await mkdir(dir, { recursive: true })
    const gcr = jsonl(rows)
    const storage = jsonl([STORAGE_ROW])
    const identity = ""
    const validators = jsonl(opts.validators ?? [OLD_VALIDATOR])
    const sum = rows.reduce((a, r) => a + BigInt(r.balance), 0n)
    const manifest = {
        schemaVersion: 2,
        source: {
            host: "test",
            chain_block_height: 563541,
            chain_block_hash: "00".repeat(32),
            node_version: "test",
            pg_version: "16",
            dumped_at: "2026-10-19T00:00:00Z",
        },
        files: {
            "gcr_main.jsonl": { sha256: sha256(gcr), rows: rows.length, balance_sum: opts.balanceSum ?? sum.toString() },
            "gcr_storageprogram.jsonl": { sha256: sha256(storage), rows: 1, size_bytes_sum: 12 },
            "identity_commitments.jsonl": { sha256: sha256(identity), rows: 0 },
            "validators.jsonl": { sha256: sha256(validators), rows: (opts.validators ?? [OLD_VALIDATOR]).length },
        },
        fork_state: opts.forkState ?? [{ fork_name: "osDenomination", applied: true }],
        transforms_applied: {
            nonces_reset_to_zero: true,
            assigned_txs_emptied: true,
            test_identity_commitments_dropped: 0,
        },
    }
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    await writeFile(join(dir, "gcr_main.jsonl"), gcr)
    await writeFile(join(dir, "gcr_storageprogram.jsonl"), storage)
    await writeFile(join(dir, "identity_commitments.jsonl"), identity)
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

/** An EntityManager that records what the restore writes. */
function fakeEm() {
    const writes = new Map<unknown, Record<string, unknown>[]>()
    const queries: string[] = []
    const push = (target: unknown, rows: unknown) => {
        const list = writes.get(target) ?? []
        list.push(...(rows as Record<string, unknown>[]))
        writes.set(target, list)
    }
    const em: Record<string, unknown> = {
        query: async (sql: string) => {
            queries.push(sql)
            return [{ count: "0" }]
        },
        insert: async (target: unknown, rows: unknown) => push(target, rows),
        createQueryBuilder: () => {
            let target: unknown
            const qb: Record<string, unknown> = {
                insert: () => qb,
                into: (t: unknown) => {
                    target = t
                    return qb
                },
                values: (rows: unknown) => {
                    push(target, rows)
                    return qb
                },
                orIgnore: () => qb,
                execute: async () => ({}),
            }
            return qb
        },
        connection: { getMetadata: () => ({ columns: [1, 2, 3] }) },
        // The surface mergeGenesisBalances uses, over the restored accounts.
        getRepository: () => ({
            findOne: async (opts: { where: { pubkey: string } }) =>
                (writes.get(GCRMain) ?? []).find(r => r.pubkey === opts.where.pubkey) ?? null,
            save: async (row: Record<string, unknown>) => {
                const list = writes.get(GCRMain) ?? []
                const i = list.findIndex(r => r.pubkey === row.pubkey)
                if (i >= 0) list[i] = { ...row }
                else list.push({ ...row })
                writes.set(GCRMain, list)
                return row
            },
            create: (row: unknown) => row,
        }),
    }
    em.manager = em
    return { em: em as never, writes, queries }
}

let work: string
let source: string
let launchFile: string
let savedForks: ForkConfigByName

beforeEach(async () => {
    savedForks = getSharedState.forkConfig
    getSharedState.forkConfig = cloneDefaultForkConfig()
    work = await mkdtemp(join(tmpdir(), "carryover-"))
    source = join(work, "source")
    await writeSnapshot(source, SOURCE_ROWS)
    launchFile = join(work, "genesis.json")
    await writeFile(launchFile, JSON.stringify({ properties: {}, validators: LAUNCH }, null, 2))
})

afterEach(async () => {
    getSharedState.forkConfig = savedForks
    await rm(work, { recursive: true, force: true })
})

describe("carry-over snapshot builder", () => {
    it("zeroes every balance and keeps every other column", async () => {
        const r = await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: join(work, "out") })
        expect(r.accounts).toBe(3)
        expect(r.zeroedAccounts).toBe(2)
        const rows = (await readFile(join(work, "out", "gcr_main.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l))
        expect(rows.map(x => x.balance)).toEqual(["0", "0", "0"])
        for (let i = 0; i < rows.length; i++) {
            expect({ ...rows[i], balance: SOURCE_ROWS[i].balance }).toEqual(SOURCE_ROWS[i])
        }
        expect(rows[0].identities).toEqual(ALICE_IDENTITIES)
        expect(rows[0].points).toEqual(ALICE_POINTS)
        expect(rows[0].referralInfo).toEqual(ALICE_REFERRAL)
    })

    it("replaces the validators with the launch list, sorted, and copies the rest byte for byte", async () => {
        const out = join(work, "out")
        await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out })
        const validators = (await readFile(join(out, "validators.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l))
        expect(validators.map(v => v.address)).toEqual([LAUNCH[1].address, LAUNCH[0].address].sort())
        expect(validators.some(v => v.address === OLD_VALIDATOR.address)).toBe(false)
        expect(Object.keys(validators[0])).toEqual([
            "address", "status", "connection_url", "staked_amount",
            "first_seen", "valid_at", "unstake_requested_at", "unstake_available_at",
        ])
        for (const name of ["gcr_storageprogram.jsonl", "identity_commitments.jsonl"]) {
            expect(await readFile(join(out, name))).toEqual(await readFile(join(source, name)))
        }
        const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))
        expect(manifest.files["gcr_main.jsonl"].balance_sum).toBe("0")
        expect(manifest.transforms_applied.balances_zeroed).toBe(true)
        expect(manifest.transforms_applied.validators_from_launch_list).toBe(true)
        expect(manifest.carryover.source_manifest_sha256).toBe(sha256(await readFile(join(source, "manifest.json"))))
        expect(Object.keys(manifest.carryover)).toEqual(["source_manifest_sha256"])
        expect(manifest.source).toEqual(JSON.parse(await readFile(join(source, "manifest.json"), "utf8")).source)
    })

    it("is deterministic: two builds give the same manifest hash", async () => {
        const a = await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: join(work, "a") })
        const b = await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: join(work, "b") })
        expect(a.manifestSha256).toBe(b.manifestSha256)
        expect(a.manifestSha256).toBe(sha256(await readFile(join(work, "a", "manifest.json"))))
        expect(a.manifestSha256).not.toBe(a.sourceManifestSha256)
    })

    it("refuses a non-empty output directory and a tampered source", async () => {
        const out = join(work, "out")
        await mkdir(out)
        await writeFile(join(out, "keep"), "x")
        await expect(buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out })).rejects.toThrow("not empty")
        await writeFile(join(source, "gcr_main.jsonl"), jsonl([gcrRow(ALICE, "1")]))
        await expect(
            buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: join(work, "o2") }),
        ).rejects.toThrow()
    })

    it("validates the launch list", () => {
        expect(() => launchValidatorRows([])).toThrow("non-empty")
        expect(() => launchValidatorRows({ validators: [{ ...LAUNCH[0], address: LAUNCH[0].address.toUpperCase() }] })).toThrow("lowercase")
        expect(() => launchValidatorRows([LAUNCH[0], LAUNCH[0]])).toThrow("twice")
        expect(() => launchValidatorRows([{ ...LAUNCH[0], staked_amount: 1000 }])).toThrow("staked_amount")
        expect(() => launchValidatorRows([{ ...LAUNCH[0], first_seen: undefined }])).toThrow("first_seen")
        expect(() => launchValidatorRows([{ ...LAUNCH[0], connection_url: "" }])).toThrow("connection_url")
        expect(launchValidatorRows(LAUNCH).map(v => v.address)).toEqual(LAUNCH.map(v => v.address).sort())
    })

    it("refuses to rewrite a row that is not in canonical JSON form", () => {
        expect(zeroBalanceLine("{\"pubkey\":\"a\",\"balance\":\"5\"}", 1)).toBe("{\"pubkey\":\"a\",\"balance\":\"0\"}")
        expect(() => zeroBalanceLine("{\"pubkey\": \"a\",\"balance\":\"5\"}", 2)).toThrow("canonical")
        expect(() => zeroBalanceLine("{\"pubkey\":\"a\",\"balance\":5}", 3)).toThrow("string balance")
    })
})

describe("genesis refusals under identityCarryover", () => {
    it("accepts the carry-over snapshot with the genesis that lists the same validators", async () => {
        const out = join(work, "out")
        await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out })
        expect(await carryoverSnapshotProblems(await load(out), LAUNCH)).toEqual([])
        expect(await carryoverSnapshotProblems(await load(out), [])).toEqual([])
        await expect(assertCarryoverSnapshot(await load(out), LAUNCH)).resolves.toBeUndefined()
    })

    it("refuses a snapshot whose rows hold a balance, before anything is written", async () => {
        const err = await assertCarryoverSnapshot(await load(source), []).catch(e => e)
        expect(err).toBeInstanceOf(GenesisRefusal)
        expect(err.message).toContain("balance_sum is \"5000000017\"")
        expect(err.message).toContain(`row 1 (${ALICE}) holds balance 5000000000`)
    })

    it("refuses a manifest that does not match its files", async () => {
        const out = join(work, "out")
        await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out })
        const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))
        manifest.files["gcr_main.jsonl"].balance_sum = "5000000017"
        await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
        await expect(load(out)).rejects.toThrow()

        // Rows edited after the build: the manifest sha256 no longer matches.
        const out2 = join(work, "out2")
        await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out2 })
        await writeFile(join(out2, "gcr_main.jsonl"), jsonl(SOURCE_ROWS))
        await expect(load(out2)).rejects.toThrow()
    })

    it("refuses a snapshot without validators.jsonl or with a different validator set", async () => {
        const out = join(work, "out")
        await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out })
        const err = await assertCarryoverSnapshot(await load(out), [LAUNCH[0]]).catch(e => e)
        expect(err).toBeInstanceOf(GenesisRefusal)
        expect(err.message).toContain(`validators.jsonl row ${LAUNCH[1].address} is not in the genesis validators`)

        const v1 = join(work, "v1")
        await writeSnapshot(v1, [gcrRow(ALICE, "0")])
        const manifest = JSON.parse(await readFile(join(v1, "manifest.json"), "utf8"))
        delete manifest.files["validators.jsonl"]
        delete manifest.fork_state
        manifest.schemaVersion = 1
        await writeFile(join(v1, "manifest.json"), JSON.stringify(manifest))
        const err2 = await assertCarryoverSnapshot(await load(v1), []).catch(e => e)
        expect(err2.message).toContain("carries no validators.jsonl")
    })

    it("compares validator entries field by field", () => {
        const rows = launchValidatorRows(LAUNCH)
        expect(launchValidatorProblems(rows, LAUNCH)).toEqual([])
        expect(launchValidatorProblems(rows, undefined)).toEqual([])
        const changed = [{ ...LAUNCH[0], staked_amount: "1001" }, LAUNCH[1]]
        expect(launchValidatorProblems(rows, changed)[0]).toContain("differs")
        expect(launchValidatorProblems(rows, [...LAUNCH, LAUNCH[0]])).toContain(`genesis validators lists ${LAUNCH[0].address} twice`)
        const objectStake = [{ ...LAUNCH[0], staked_amount: { amount: "1000" } }, LAUNCH[1]]
        expect(launchValidatorProblems(rows, objectStake).join()).toContain(
            `genesis validator ${LAUNCH[0].address}: staked_amount must be a string or a number`,
        )
        expect(launchValidatorProblems(rows, [{ ...LAUNCH[0], status: true }, LAUNCH[1]]).join()).toContain("status must be")
    })
})

describe("restore under identityCarryover", () => {
    it("imports zero balances, keeps identities, points and referrals, seeds the launch validators and records imported identities", async () => {
        const out = join(work, "out")
        await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out })
        const { em, writes, queries } = fakeEm()
        const report = await restoreSnapshot(em, await load(out), { carryover: true })

        const accounts = writes.get(GCRMain)!
        expect(accounts.map(a => a.balance)).toEqual([0n, 0n, 0n])
        expect(accounts[0].identities).toEqual(ALICE_IDENTITIES)
        expect(accounts[0].points).toEqual(ALICE_POINTS)
        expect(accounts[0].referralInfo).toEqual(ALICE_REFERRAL)

        expect(writes.get(Validators)!.map(v => v.address)).toEqual(LAUNCH.map(v => v.address).sort())

        const keys = writes.get(GenesisImportedIdentity)!.map(r => r.identityKey)
        expect(keys).toEqual([
            "humanpassport:0xaaaa",
            "nomis:evm:mainnet:0xabcdef0000000000000000000000000000000001",
            "ud:alice.crypto",
            "web2:github:222",
            "web2:twitter:111",
            "xm:evm:mainnet:0xabcdef0000000000000000000000000000000001",
            "xm:solana:mainnet:so1anaaddr",
        ].sort())
        expect(report.importedIdentities).toBe(7)
        expect(queries.some(q => q.includes("genesis_imported_identities"))).toBe(true)
    })

    it("refuses a row with a balance inside the restore too", async () => {
        const { em } = fakeEm()
        const err = await restoreSnapshot(em, await load(source), { carryover: true }).catch(e => e)
        expect(err).toBeInstanceOf(GenesisRefusal)
        expect(err.message).toContain("holds balance 5000000000")
    })

    it("leaves a restore without the fork unchanged", async () => {
        const { em, writes, queries } = fakeEm()
        const report = await restoreSnapshot(em, await load(source))
        expect(writes.get(GCRMain)!.map(a => a.balance)).toEqual([5000000000n, 0n, 17n])
        expect(writes.get(Validators)!.map(v => v.address)).toEqual([OLD_VALIDATOR.address])
        expect(writes.has(GenesisImportedIdentity)).toBe(false)
        expect(report.importedIdentities).toBe(0)
        expect(queries.some(q => q.includes("genesis_imported_identities"))).toBe(false)
    })
})

describe("identity keys", () => {
    it("keys each identity as the first-link check looks it up", () => {
        expect(firstConnectionKey("twitter", { userId: "111" })).toBe("web2:twitter:111")
        expect(firstConnectionKey("github", { userId: 222 as never })).toBe(firstConnectionKey("github", { userId: "222" }))
        expect(firstConnectionKey("discord", {})).toBeNull()
        expect(firstConnectionKey("web3", { chain: "evm", subchain: "mainnet", address: " 0xAB " })).toBe("xm:evm:mainnet:0xab")
        expect(firstConnectionKey("web3", { chain: "solana", subchain: "mainnet", address: "AbC" })).toBe("xm:solana:mainnet:abc")
        expect(firstConnectionKey("ethos", { chain: "evm", subchain: "mainnet", address: "0xAB" })).toBe("ethos:evm:mainnet:0xab")
        expect(firstConnectionKey("ud", { domain: "X.Crypto" })).toBe("ud:x.crypto")
        expect(firstConnectionKey("humanpassport", { address: "0xAB" })).toBe("humanpassport:0xab")
    })

    it("walks every identity tree and ignores what cannot earn an award", () => {
        expect(importedIdentityKeys(null)).toEqual([])
        expect(importedIdentityKeys({ web2: { reddit: [{ userId: "1" }] }, pqc: { x: [] } })).toEqual([])
        expect(importedIdentityKeys(SOURCE_ROWS[1].identities)).toEqual(["web2:twitter:111"])
    })
})

const carryoverAtZero = () => loadForkConfigFromGenesis({ forks: { identityCarryover: { activationHeight: 0 } } })

async function buildOut(name = "out"): Promise<string> {
    const out = join(work, name)
    await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: out })
    return out
}

describe("carry-over manifest binding", () => {
    it("rebuilding from the final genesis, which names the manifest hash, gives the same manifest", async () => {
        const first = await buildCarryoverSnapshot({ inDir: source, validatorsFile: launchFile, outDir: join(work, "a") })
        const genesis = JSON.parse(await readFile(launchFile, "utf8"))
        const finalFile = join(work, "genesis.final.json")
        // Different formatting too: only the validator entries may matter.
        await writeFile(finalFile, JSON.stringify({ ...genesis, snapshot: { manifestSha256: first.manifestSha256 } }))
        const again = await buildCarryoverSnapshot({ inDir: source, validatorsFile: finalFile, outDir: join(work, "b") })
        expect(again.manifestSha256).toBe(first.manifestSha256)
    })

    it("refuses a source snapshot that does not record osDenomination as applied", async () => {
        for (const forkState of [[], [{ fork_name: "osDenomination", applied: false }]]) {
            const pre = join(work, `pre-${forkState.length}`)
            await writeSnapshot(pre, SOURCE_ROWS, { forkState })
            await expect(
                buildCarryoverSnapshot({ inDir: pre, validatorsFile: launchFile, outDir: join(work, `o-${forkState.length}`) }),
            ).rejects.toThrow("osDenomination")
        }
        const out = await buildOut()
        const manifest = (await load(out)).manifest
        expect(carryoverManifestProblems(manifest)).toEqual([])
        expect(carryoverManifestProblems({ ...manifest, fork_state: [] }).join()).toContain("osDenomination")
    })

    it("refuses launch validators with an unstake under way", async () => {
        const unstaking = { ...LAUNCH[0], unstake_requested_at: 5, unstake_available_at: null }
        expect(() => launchValidatorRows([unstaking])).toThrow("unstake")
        const rows = launchValidatorRows(LAUNCH)
        const pending = [{ ...rows[0], unstake_available_at: 9 }, rows[1]]
        expect(launchValidatorProblems(pending as never, []).join()).toContain("unstake under way")
        expect(launchValidatorProblems(rows, [{ ...LAUNCH[0], unstake_requested_at: 1 }, LAUNCH[1]]).join()).toContain("differs")
    })

    it("refuses balances of mixed sign that sum to zero", async () => {
        const mixed = join(work, "mixed")
        await writeSnapshot(mixed, [gcrRow(ALICE, "5"), gcrRow(BOB, "-5")])
        const err = await load(mixed).then(l => assertCarryoverSnapshot(l, [])).catch(e => e)
        expect(err).toBeInstanceOf(Error)
        expect(err.message).toContain("holds balance")
    })
})

describe("genesis state wiring", () => {
    function recordingSteps(calls: string[]): GenesisStateSteps {
        return {
            assertCarryover: async () => void calls.push("assert"),
            restore: async (_em, _loader, options) => {
                calls.push(`restore carryover=${options?.carryover === true}`)
                return {} as never
            },
            mergeBalances: async () => {
                calls.push("merge")
                return {} as never
            },
            applyForks: async () => {
                calls.push("forks")
                return {} as never
            },
            seedValidators: async () => {
                calls.push("seed")
                return {} as never
            },
        }
    }
    const tx = (calls: string[]) => async <T>(work: (em: never) => Promise<T>): Promise<T> => {
        calls.push("begin")
        const r = await work({} as never)
        calls.push("commit")
        return r
    }

    it("checks the snapshot before the transaction and hands the carryover flag to the restore", async () => {
        carryoverAtZero()
        const calls: string[] = []
        expect(await restoreGenesisState(tx(calls), await load(await buildOut()), { validators: LAUNCH }, recordingSteps(calls))).toBe(true)
        expect(calls).toEqual(["assert", "begin", "restore carryover=true", "merge", "forks", "commit"])
    })

    it("skips the carry-over check before the fork, and seeds genesis validators only without validators.jsonl", async () => {
        const calls: string[] = []
        const v1 = join(work, "v1")
        await writeSnapshot(v1, [gcrRow(ALICE, "0")])
        const manifest = JSON.parse(await readFile(join(v1, "manifest.json"), "utf8"))
        delete manifest.files["validators.jsonl"]
        manifest.schemaVersion = 1
        await writeFile(join(v1, "manifest.json"), JSON.stringify(manifest))
        await restoreGenesisState(tx(calls), await load(v1), { validators: LAUNCH }, recordingSteps(calls))
        expect(calls).toEqual(["begin", "restore carryover=false", "merge", "forks", "seed", "commit"])
    })

    it("refuses a carry-over genesis without a snapshot, and falls back to the legacy path otherwise", async () => {
        const calls: string[] = []
        expect(await restoreGenesisState(tx(calls), { available: false }, {}, recordingSteps(calls))).toBe(false)
        carryoverAtZero()
        const err = await restoreGenesisState(tx(calls), { available: false }, {}, recordingSteps(calls)).catch(e => e)
        expect(err).toBeInstanceOf(GenesisRefusal)
        expect(calls).toEqual([])
    })

    it("refuses a refused snapshot before the transaction opens", async () => {
        carryoverAtZero()
        const calls: string[] = []
        const steps = { ...recordingSteps(calls), assertCarryover: assertCarryoverSnapshot }
        const err = await restoreGenesisState(tx(calls), await load(source), {}, steps).catch(e => e)
        expect(err).toBeInstanceOf(GenesisRefusal)
        expect(calls).toEqual([])
    })

    it("applies genesis.balances after the zero-balance import", async () => {
        carryoverAtZero()
        const dave = hex64("dave")
        const { em, writes } = fakeEm()
        const steps: GenesisStateSteps = {
            ...recordingSteps([]),
            assertCarryover: assertCarryoverSnapshot,
            restore: restoreSnapshot,
            mergeBalances: (await import("@/libs/blockchain/genesis/mergeGenesisBalances")).mergeGenesisBalances,
        }
        await restoreGenesisState(
            async work => work(em),
            await load(await buildOut()),
            { validators: LAUNCH, balances: [[ALICE, "1000"], [dave, 7]] },
            steps,
        )
        const accounts = writes.get(GCRMain)!
        const byKey = new Map(accounts.map(a => [a.pubkey, a]))
        expect(byKey.get(ALICE)!.balance).toBe(1000n)
        expect(byKey.get(ALICE)!.identities).toEqual(ALICE_IDENTITIES)
        expect(byKey.get(ALICE)!.points).toEqual(ALICE_POINTS)
        expect(byKey.get(BOB)!.balance).toBe(0n)
        expect(byKey.get(CAROL)!.balance).toBe(0n)
        expect(byKey.get(dave)!.balance).toBe(7n)
    })

    it("rolls back a restore that refuses a row part way through", async () => {
        carryoverAtZero()
        const late = join(work, "late")
        // The funded row comes last, after rows the restore has already taken.
        await writeSnapshot(late, [gcrRow(BOB, "0"), gcrRow(ALICE, "0"), gcrRow(CAROL, "17")])
        const committed = new Map<unknown, unknown[]>()
        let staged: ReturnType<typeof fakeEm> | null = null
        const transaction = async <T>(work: (em: never) => Promise<T>): Promise<T> => {
            staged = fakeEm()
            const r = await work(staged.em)
            for (const [k, v] of staged.writes) committed.set(k, v)
            return r
        }
        // Skip the up-front check so the refusal comes from inside the transaction.
        const steps: GenesisStateSteps = { ...recordingSteps([]), assertCarryover: async () => {}, restore: restoreSnapshot }
        const err = await restoreGenesisState(transaction, await load(late), {}, steps).catch(e => e)
        expect(err).toBeInstanceOf(GenesisRefusal)
        expect(err.message).toContain(`row 3 (${CAROL}) holds balance 17`)
        expect(staged).not.toBeNull()
        expect(committed.size).toBe(0)
    })
})

describe("fresh genesis refusals under identityCarryover", () => {
    it("refuses a carry-over genesis that declares no snapshot", () => {
        const problems = freshGenesisProblems({
            genesisData: { balances: [] },
            pin: "",
            restore: false,
            snapshotManifestHash: null,
            carryoverAtGenesis: true,
        })
        expect(problems.join()).toContain("does not declare snapshot.manifestSha256")
        expect(
            freshGenesisProblems({ genesisData: { balances: [] }, pin: "", restore: false, snapshotManifestHash: null }),
        ).toEqual([])
        expect(
            freshGenesisProblems({
                genesisData: { snapshot: { manifestSha256: "ab".repeat(32) } },
                pin: "",
                restore: false,
                snapshotManifestHash: "ab".repeat(32),
                carryoverAtGenesis: true,
            }),
        ).toEqual([])
    })
})

describe("imported-identity registry", () => {
    async function restoredKeys(out: string): Promise<string[]> {
        const { em, writes } = fakeEm()
        await restoreSnapshot(em, await load(out), { carryover: true })
        return writes.get(GenesisImportedIdentity)!.map(r => r.identityKey as string)
    }

    it("two restores of the same snapshot record the same keys", async () => {
        const out = await buildOut()
        const a = await restoredKeys(out)
        const b = await restoredKeys(out)
        expect(a).toEqual(b)
        expect(importedIdentityDigest(a)).toEqual(await expectedImportedIdentities(await load(out)))
    })

    it("refuses a boot whose registry does not match the snapshot block 0 declares", async () => {
        const out = await buildOut()
        const manifestHash = sha256(await readFile(join(out, "manifest.json")))
        const forks = { identityCarryover: { activationHeight: 0 } }
        const stored = { forks, snapshot: { manifestSha256: manifestHash } }
        const keys = await restoredKeys(out)
        const readers = (storedKeys: string[], dir = out) => ({
            openGcrMain: (sha: string) => openBoundGcrMain(sha, dir),
            storedKeys: async () => storedKeys,
        })

        expect(await importedIdentityProblems(stored, readers([...keys].reverse()))).toEqual([])
        expect((await importedIdentityProblems(stored, readers(keys.slice(1)))).join()).toContain(
            `holds ${keys.length - 1} keys`,
        )
        const swapped = [...keys.slice(1), "web2:twitter:999"]
        expect((await importedIdentityProblems(stored, readers(swapped))).join()).toContain("digest")
        expect((await importedIdentityProblems(stored, readers(keys, join(work, "gone")))).join()).toContain(
            "no snapshot manifest",
        )
        const otherManifest = { forks, snapshot: { manifestSha256: "cd".repeat(32) } }
        expect((await importedIdentityProblems(otherManifest, readers(keys))).join()).toContain(
            `block 0 declares ${"cd".repeat(32)}`,
        )
        // A block 0 without a snapshot restored nothing.
        expect(await importedIdentityProblems({ forks }, readers([]))).toEqual([])
        expect((await importedIdentityProblems({ forks }, readers(keys))).join()).toContain("declares no snapshot")
    })

    it("re-checks gcr_main.jsonl only, against the manifest block 0 bound", async () => {
        const out = await buildOut()
        const manifestHash = sha256(await readFile(join(out, "manifest.json")))
        const stored = { forks: { identityCarryover: { activationHeight: 0 } }, snapshot: { manifestSha256: manifestHash } }
        const keys = await restoredKeys(out)
        const readers = { openGcrMain: (sha: string) => openBoundGcrMain(sha, out), storedKeys: async () => keys }

        // The other files were checked when block 0 was built and are not re-read.
        await writeFile(join(out, "gcr_storageprogram.jsonl"), "tampered\n")
        await writeFile(join(out, "validators.jsonl"), "tampered\n")
        expect(await importedIdentityProblems(stored, readers)).toEqual([])

        await writeFile(join(out, "gcr_main.jsonl"), jsonl([gcrRow(ALICE, "0")]))
        const problems = (await importedIdentityProblems(stored, readers)).join()
        expect(problems).toContain("the snapshot manifest is present but the snapshot could not be loaded")
        expect(problems).toContain("gcr_main.jsonl: sha256 mismatch")
    })

    it("takes the fork schedule from block 0, not from the genesis file", async () => {
        const keys = ["web2:twitter:111"]
        const readers = {
            openGcrMain: async () => ({ status: "missing" }) as const,
            storedKeys: async () => keys,
        }
        const carryoverBlock0 = {
            forks: { identityCarryover: { activationHeight: 0 } },
            snapshot: { manifestSha256: "ab".repeat(32) },
        }
        // data/genesis.json edited or gone: the node's loaded schedule has no
        // carryover, and the check still runs.
        getSharedState.forkConfig = cloneDefaultForkConfig()
        expect((await importedIdentityProblems(carryoverBlock0, readers)).join()).toContain("no snapshot manifest")

        // A testnet or devnet block 0 never scheduled the fork: untouched,
        // whatever the genesis file now says.
        carryoverAtZero()
        for (const block0 of [
            { snapshot: { manifestSha256: "ab".repeat(32) } },
            { forks: { identityCarryover: { activationHeight: null } }, snapshot: { manifestSha256: "ab".repeat(32) } },
            { forks: { identityCarryover: { activationHeight: 10 } } },
            null,
        ]) {
            expect(await importedIdentityProblems(block0, readers)).toEqual([])
        }
    })
})
