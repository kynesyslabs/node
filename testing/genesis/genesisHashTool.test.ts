/**
 * scripts/genesis-hash.ts publishes block 0's hash before launch. It is only
 * worth publishing if it is the hash a node builds and serves for the same
 * file, so this compares it with the node's own boot path.
 */

import { describe, it, expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadForkConfigFromGenesis } from "src/forks"
import { generateGenesisBlock } from "src/libs/blockchain/chainGenesis"
import { genesisValues, readGenesisFile, verifiedSnapshot } from "../../scripts/genesis-hash"

class Stop extends Error {}

/** The hash findGenesisBlock checks against EXPECTED_GENESIS_BLOCK_HASH, taken before any database write. */
async function nodeBlockZeroHash(file: string): Promise<string> {
    const genesis = JSON.parse(readFileSync(file, "utf8"))
    loadForkConfigFromGenesis(genesis)
    let seen: string | null = null
    await generateGenesisBlock(genesis, hash => {
        seen = hash
        throw new Stop()
    }).catch(e => {
        if (!(e instanceof Stop)) throw e
    })
    if (seen === null) throw new Error("generateGenesisBlock never reported block 0's hash")
    return seen
}

function writeGenesis(data: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "genesis-hash-tool-"))
    const file = join(dir, "genesis.json")
    writeFileSync(file, JSON.stringify(data, null, 4))
    return file
}

function launchGenesis(): Record<string, any> {
    return JSON.parse(readFileSync("testing/genesis/fixtures/block0-genesis.json", "utf8"))
}

describe("genesis-hash tool", () => {
    it("prints the block 0 hash a node builds from the same file", async () => {
        const file = writeGenesis(launchGenesis())
        const values = genesisValues(readGenesisFile(file))
        expect(values.genesisBlockHash).toMatch(/^[0-9a-f]{64}$/)
        expect(values.genesisBlockHash).toBe(await nodeBlockZeroHash(file))
        // Different by construction; passing one for the other is the mistake to avoid
        expect(values.genesisBlockHash).not.toBe(values.genesisDataHash)
    })

    it("follows the file's key order, as the node does", async () => {
        const file = writeGenesis(Object.fromEntries(Object.entries(launchGenesis()).reverse()))
        const values = genesisValues(readGenesisFile(file))
        expect(values.genesisBlockHash).toBe(await nodeBlockZeroHash(file))
        expect(values.genesisBlockHash).not.toBe(genesisValues(launchGenesis()).genesisBlockHash)
    })

    it("reads a genesis file holding its JSON as a string, as the node does", () => {
        const plain = writeGenesis(launchGenesis())
        const encoded = writeGenesis(JSON.stringify(launchGenesis()))
        expect(readGenesisFile(encoded)).toEqual(readGenesisFile(plain))
        expect(genesisValues(readGenesisFile(encoded)).genesisBlockHash).toBe(
            genesisValues(readGenesisFile(plain)).genesisBlockHash,
        )
    })

    it("prints no block hash for a genesis without a fixed timestamp", () => {
        const { timestamp: _, ...noTimestamp } = launchGenesis()
        const values = genesisValues(noTimestamp)
        expect(values.genesisBlockHash).toBeNull()
        expect(values.problems.join("\n")).toContain("genesis has no timestamp")
    })

    it("prints the same hash from the command line", () => {
        const file = writeGenesis(launchGenesis())
        const run = Bun.spawnSync(["bun", "scripts/genesis-hash.ts", "--genesis", file, "--json"], {
            stdout: "pipe",
            stderr: "pipe",
        })
        const out = run.stdout.toString()
        const json = JSON.parse(out.slice(out.indexOf("{")))
        expect(json.genesisBlockHash).toBe(genesisValues(readGenesisFile(file)).genesisBlockHash)

        const text = Bun.spawnSync(["bun", "scripts/genesis-hash.ts", "--genesis", file], { stdout: "pipe" })
            .stdout.toString()
        expect(text).toContain(`genesis block hash: ${json.genesisBlockHash}`)
        expect(text).toContain(`EXPECTED_GENESIS_BLOCK_HASH=${json.genesisBlockHash}\n`)
        expect(text).toContain(`EXPECTED_GENESIS_HASH=${json.genesisDataHash}\n`)
    }, 60_000)

    it("reports a sudo key and balances the node would refuse after block 0", () => {
        const clean = genesisValues(launchGenesis())
        expect(clean.problems.filter(p => /sudoPubkey|BALANCES/.test(p))).toEqual([])

        const g = launchGenesis()
        g.properties = { ...g.properties, sudoPubkey: "FILL: a key" }
        g.balances = [
            ["0x" + "a".repeat(64), "12"],
            ["0x" + "b".repeat(64), "-1"],
            "FILL",
            ["FILL: an address", "5"],
        ]
        const problems = genesisValues(g).problems.join("\n")
        expect(problems).toContain("properties.sudoPubkey")
        expect(problems).toContain("entry 1")
        expect(problems).toContain("entry 2")
        expect(problems).toContain("entry 3")
        expect(problems).not.toContain("entry 0")

        expect(genesisValues({ ...launchGenesis(), balances: "FILL: allocations" }).problems.join("\n")).toContain(
            "balances is present but not an array",
        )
    })

    describe("--snapshot", () => {
        const sha256 = (b: string) => createHash("sha256").update(b).digest("hex")
        /** A snapshot the node's verifySnapshot accepts; `tamper` changes gcr_main after the manifest is written. */
        function snapshot(tamper = false): string {
            const dir = mkdtempSync(join(tmpdir(), "genesis-hash-snapshot-"))
            for (const f of ["gcr_main.jsonl", "gcr_storageprogram.jsonl", "identity_commitments.jsonl"]) {
                writeFileSync(join(dir, f), "")
            }
            writeFileSync(
                join(dir, "manifest.json"),
                JSON.stringify({
                    schemaVersion: 1,
                    source: {
                        host: "test",
                        chain_block_height: 0,
                        chain_block_hash: "0x0",
                        node_version: "test",
                        pg_version: "test",
                        dumped_at: "2026-10-29T00:00:00Z",
                    },
                    files: {
                        "gcr_main.jsonl": { sha256: sha256(""), rows: 0, balance_sum: "0" },
                        "gcr_storageprogram.jsonl": { sha256: sha256(""), rows: 0, size_bytes_sum: 0 },
                        "identity_commitments.jsonl": { sha256: sha256(""), rows: 0 },
                    },
                    transforms_applied: {
                        nonces_reset_to_zero: true,
                        assigned_txs_emptied: true,
                        test_identity_commitments_dropped: true,
                    },
                }),
            )
            if (tamper) writeFileSync(join(dir, "gcr_main.jsonl"), '{"pubkey":"0x00","balance":"1"}\n')
            return dir
        }

        it("verifies the snapshot as the node does at boot", async () => {
            expect(await verifiedSnapshot(snapshot())).toEqual({ forkState: [], problems: [] })
            const bad = await verifiedSnapshot(snapshot(true))
            expect(bad.forkState).toBeNull()
            expect(bad.problems.join("\n")).toContain("a node would refuse the snapshot at boot")
            expect(bad.problems.join("\n")).toContain("gcr_main.jsonl: sha256 mismatch")
        })

        it("fails the command line on a snapshot the node refuses", () => {
            const dir = snapshot(true)
            const g = launchGenesis()
            g.snapshot = { manifestSha256: sha256(readFileSync(join(dir, "manifest.json"), "utf8")) }
            const file = writeGenesis(g)
            const run = Bun.spawnSync(["bun", "scripts/genesis-hash.ts", "--genesis", file, "--snapshot", dir], {
                stdout: "pipe",
                stderr: "pipe",
            })
            expect(run.exitCode).toBe(1)
            expect(run.stdout.toString()).toContain("problem: a node would refuse the snapshot at boot")
        }, 60_000)
    })
})
