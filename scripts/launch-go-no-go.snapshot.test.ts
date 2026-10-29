/**
 * Block 0's validator set follows the node's snapshot precedence: a
 * snapshot with validators.jsonl owns it and genesis.validators is ignored.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAINNET_FORKS, type ValidatorProbe, checkLaunch } from "./launch-go-no-go"
import { NO_SNAPSHOT_REASON, activeAtBlockZero, readBlockZeroValidators } from "./launch-validator-set"

const id = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0")
const GENESIS = "genesis-a"
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

const dirs: string[] = []
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function row(i: number, status = "2") {
    return {
        address: id(i),
        status,
        connection_url: `http://v${i}:53550`,
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
        unstake_requested_at: null,
        unstake_available_at: null,
    }
}

/** A snapshot directory the node's loader accepts, with optional validators.jsonl. */
function snapshotDir(validators: object[] | null, { manifest = true } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "go-no-go-snapshot-"))
    dirs.push(dir)
    for (const f of ["gcr_main.jsonl", "gcr_storageprogram.jsonl", "identity_commitments.jsonl"]) {
        writeFileSync(join(dir, f), "")
    }
    const files: Record<string, object> = {
        "gcr_main.jsonl": { sha256: sha256(""), rows: 0, balance_sum: "0" },
        "gcr_storageprogram.jsonl": { sha256: sha256(""), rows: 0, size_bytes_sum: 0 },
        "identity_commitments.jsonl": { sha256: sha256(""), rows: 0 },
    }
    if (validators) {
        const body = validators.map(v => JSON.stringify(v)).join("\n") + "\n"
        writeFileSync(join(dir, "validators.jsonl"), body)
        files["validators.jsonl"] = { sha256: sha256(body), rows: validators.length }
    }
    if (manifest) {
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({
                schemaVersion: validators ? 2 : 1,
                source: {
                    host: "test",
                    chain_block_height: 0,
                    chain_block_hash: "0x0",
                    node_version: "test",
                    pg_version: "test",
                    dumped_at: "2026-10-29T00:00:00Z",
                },
                files,
                ...(validators ? { fork_state: [] } : {}),
                transforms_applied: {
                    nonces_reset_to_zero: true,
                    assigned_txs_emptied: true,
                    test_identity_commitments_dropped: true,
                },
            }),
        )
    }
    return dir
}

const genesisRows = Array.from({ length: 10 }, (_, i) => row(i))
const genesis = {
    properties: { id: 1, shardSize: 10 },
    forks: Object.fromEntries(MAINNET_FORKS.map(name => [name, { activationHeight: 0 }])),
    validators: genesisRows,
}

function online(identity: string): ValidatorProbe {
    return { identity, url: "", reachable: true, reportedIdentity: identity, genesisHash: GENESIS, identityProof: "verified" }
}

describe("block 0 validator set", () => {
    it("takes the snapshot's validators.jsonl over genesis.validators and reports the difference", async () => {
        // Snapshot: validators 0-6 and 20-22; genesis lists 0-9
        const snapshotRows = [...[0, 1, 2, 3, 4, 5, 6].map(i => row(i)), ...[20, 21, 22].map(i => row(i))]
        const set = await readBlockZeroValidators(genesis, snapshotDir(snapshotRows))
        expect(set.source).toBe("snapshot")
        expect(set.rows.map(r => r.address)).toEqual(snapshotRows.map(r => r.address))
        const warning = set.warnings.join("\n")
        expect(warning).toContain("differs from genesis.validators")
        expect(warning).toContain(`only in the snapshot: ${id(20)}, ${id(21)}, ${id(22)}`)
        expect(warning).toContain(`only in genesis.validators (ignored): ${id(7)}, ${id(8)}, ${id(9)}`)

        // Everything genesis.validators lists is online, but three of them
        // are not validators at all: the real set has 7 of 10 up
        const operators = Object.fromEntries(
            [...genesisRows, ...snapshotRows].map((r, i) => [r.address, { operator: `op-${i % 5}`, provider: `c-${i % 5}` }]),
        )
        const probes = genesisRows.map(r => online(r.address))
        const d = checkLaunch({ shardSize: 10, genesis, blockZero: set, probes, operators, expectedGenesisHash: GENESIS })
        expect(d.launchCount).toBe(10)
        expect(d.validators.map(v => v.identity)).toContain(id(20))
        expect(d.validators.map(v => v.identity)).not.toContain(id(7))
        expect(d.countedInCommittee).toHaveLength(7)
        expect(d.warnings.join("\n")).toContain("differs from genesis.validators")
    })

    it("uses genesis.validators when the snapshot has no validators.jsonl", async () => {
        const set = await readBlockZeroValidators(genesis, snapshotDir(null))
        expect(set.source).toBe("genesis")
        expect(set.rows).toBe(genesisRows)
        expect(set.warnings).toEqual([])
        expect(set.reasons).toEqual([])
    })

    it("keeps the node's seeding logs off stdout", async () => {
        const written: string[] = []
        const realWrite = process.stdout.write.bind(process.stdout)
        const realLog = console.log
        process.stdout.write = ((chunk: string | Uint8Array) => {
            written.push(String(chunk))
            return true
        }) as typeof process.stdout.write
        console.log = (...a: unknown[]) => void written.push(a.join(" "))
        try {
            await readBlockZeroValidators(genesis, snapshotDir(null))
            // The terminal sink flushes on a later tick
            await new Promise(r => setTimeout(r, 50))
        } finally {
            process.stdout.write = realWrite
            console.log = realLog
        }
        expect(written).toEqual([])
    })

    it("does not warn when the snapshot matches genesis.validators", async () => {
        const set = await readBlockZeroValidators(genesis, snapshotDir(genesisRows))
        expect(set.source).toBe("snapshot")
        expect(set.warnings).toEqual([])
    })

    it("is NO-GO for a snapshot directory the node would not load", async () => {
        const set = await readBlockZeroValidators(genesis, snapshotDir(genesisRows, { manifest: false }))
        expect(set.source).toBe("none")
        expect(set.rows).toEqual([])
        expect(set.reasons.join("\n")).toContain("seeds no validators at block 0")
    })

    it("refuses a missing directory and a tampered snapshot", async () => {
        await expect(readBlockZeroValidators(genesis, join(tmpdir(), "no-such-snapshot-dir-x"))).rejects.toThrow(
            "does not exist",
        )
        const dir = snapshotDir(genesisRows)
        writeFileSync(join(dir, "validators.jsonl"), JSON.stringify(row(30)) + "\n")
        await expect(readBlockZeroValidators(genesis, dir)).rejects.toThrow("sha256 mismatch")
    })

    it("is NO-GO without --snapshot, since the node seeds no validators without a snapshot", async () => {
        const set = await readBlockZeroValidators(genesis, null)
        expect(set.source).toBe("none")
        expect(set.reasons).toEqual([NO_SNAPSHOT_REASON])
        // The genesis endpoints are still there to probe
        expect(set.rows).toBe(genesisRows)
        const probes = genesisRows.map(r => online(r.address))
        const operators = Object.fromEntries(genesisRows.map((r, i) => [r.address, { operator: `op-${i % 4}`, provider: `c-${i % 4}` }]))
        const d = checkLaunch({ shardSize: 10, genesis, blockZero: set, probes, operators, expectedGenesisHash: GENESIS })
        expect(d.go).toBe(false)
        expect(d.reasons.join("\n")).toContain("pass --snapshot DIR")
    })

    it("leaves a snapshot row with a null valid_at out, as the node's valid_at <= 0 query does", async () => {
        const rows = [...genesisRows.slice(0, 9), { ...row(9), valid_at: null }]
        const set = await readBlockZeroValidators(genesis, snapshotDir(rows))
        expect(set.rows).toHaveLength(10)
        expect(activeAtBlockZero(set.rows).map(r => r.address)).not.toContain(id(9))
    })

    it("is NO-GO when genesis.validators holds a row the node refuses to seed", async () => {
        // No validators.jsonl, so the node seeds genesis.validators and stops on a row without valid_at
        const { valid_at: _, ...noValidAt } = row(9)
        const bad = { ...genesis, validators: [...genesisRows.slice(0, 9), noValidAt] }
        const set = await readBlockZeroValidators(bad, snapshotDir(null))
        expect(set.reasons.join("\n")).toContain("would stop the node at boot")
        expect(set.reasons.join("\n")).toContain("valid_at must be a non-negative integer")
        expect(activeAtBlockZero(set.rows)).toHaveLength(9)
    })

    it("is NO-GO when genesis.validators lists an address twice", async () => {
        const dup = { ...genesis, validators: [...genesisRows.slice(0, 9), row(0)] }
        const set = await readBlockZeroValidators(dup, snapshotDir(null))
        expect(set.reasons.join("\n")).toContain(`genesis.validators lists these validators more than once: ${id(0)}`)
    })

    it("is NO-GO when the snapshot lists one identity twice in different case", async () => {
        const rows = [...genesisRows.slice(0, 9), { ...row(0), address: id(0).toUpperCase().replace("0X", "0x") }]
        const set = await readBlockZeroValidators(genesis, snapshotDir(rows))
        expect(set.reasons.join("\n")).toContain(`validators.jsonl lists these validators more than once: ${id(0)}`)
    })

    it("leaves the node's snapshot directory variable as it was", async () => {
        const before = process.env.DEMOS_SNAPSHOT_DIR
        await readBlockZeroValidators(genesis, snapshotDir(null))
        expect(process.env.DEMOS_SNAPSHOT_DIR).toBe(before)
    })
})
