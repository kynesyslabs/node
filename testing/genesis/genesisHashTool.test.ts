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
import { SHARD_SIZE_MAX, SHARD_SIZE_MIN } from "src/libs/consensus/genesisShardSize"
import { quorumThreshold } from "src/libs/consensus/v2/quorum"
import {
    connectionUrlProblem,
    genesisNetworkFindings,
    genesisNetworkProblems,
    genesisValues,
    parseArgs,
    readGenesisFile,
    snapshotValidatorRows,
    verifiedSnapshot,
} from "../../scripts/genesis-hash"

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

    describe("network checks a pinned hash does not make", () => {
        const validator = (i: number, url: unknown = `http://10.0.0.${i}:53550`) => ({
            address: "0x" + i.toString(16).padStart(64, "0"),
            status: "2",
            connection_url: url,
            staked_amount: "1000000000000",
            first_seen: 0,
            valid_at: 0,
        })
        const network = (shardSize: unknown, validators: unknown[]) => {
            const g = launchGenesis()
            g.properties = { ...g.properties, shardSize }
            g.validators = validators
            return g
        }
        const many = (n: number) => Array.from({ length: n }, (_, i) => validator(i + 1))

        it("reports a shardSize the node refuses at boot", () => {
            for (const bad of [SHARD_SIZE_MIN - 1, SHARD_SIZE_MAX + 1, 1, "10", undefined]) {
                const problems = genesisNetworkProblems(network(bad, many(10)))
                expect([bad, problems.some(p => p.includes("properties.shardSize"))]).toEqual([bad, true])
            }
            const ok = genesisNetworkProblems(network(SHARD_SIZE_MIN, many(SHARD_SIZE_MIN)))
            expect(ok).toEqual([])
            expect(genesisNetworkProblems(network(1, many(1))).join("\n")).toContain(
                `must be within [${SHARD_SIZE_MIN}, ${SHARD_SIZE_MAX}], got 1: a node refuses this genesis at boot`,
            )
        })

        it("reports fewer validators than the node's quorum of shardSize", () => {
            for (const shardSize of [SHARD_SIZE_MIN, 4, 10, SHARD_SIZE_MAX]) {
                const quorum = quorumThreshold(shardSize)
                const short = genesisNetworkProblems(network(shardSize, many(quorum - 1)))
                expect(short).toEqual([
                    `${quorum - 1} validators in genesis validators, below the quorum of ${quorum} ` +
                        `(2/3 + 1 of shardSize ${shardSize}): a node boots on this genesis but no block after block 0 can be forged`,
                ])
                expect(genesisNetworkProblems(network(shardSize, many(quorum)))).toEqual([])
            }
            // The rehearsal genesis that never forged: one validator, shardSize 10
            expect(genesisNetworkProblems(network(10, many(1)))[0]).toStartWith("1 validators in genesis validators, below the quorum of 7")
        })

        it("counts the snapshot's validators when the snapshot carries them, as the node seeds them", () => {
            expect(genesisNetworkProblems(network(10, many(1)), 7)).toEqual([])
            expect(genesisNetworkProblems(network(10, many(10)), 6)[0]).toStartWith(
                "6 validators in the snapshot's validators.jsonl, below the quorum of 7",
            )
            const dir = mkdtempSync(join(tmpdir(), "genesis-hash-rows-"))
            expect(snapshotValidatorRows(dir)).toBeNull()
            writeFileSync(join(dir, "manifest.json"), JSON.stringify({ files: { "gcr_main.jsonl": { rows: 3 } } }))
            expect(snapshotValidatorRows(dir)).toBeNull()
            writeFileSync(join(dir, "manifest.json"), JSON.stringify({ files: { "validators.jsonl": { rows: 9 } } }))
            expect(snapshotValidatorRows(dir)).toBe(9)
            writeFileSync(join(dir, "manifest.json"), "{ not json")
            expect(snapshotValidatorRows(dir)).toBeNull()
        })

        it("reports a validator URL no peer can dial", () => {
            expect(connectionUrlProblem("http://45.13.233.189:65550")).toBe("port 65550 is outside 1-65535")
            expect(connectionUrlProblem("http://node.example.com:0/")).toBe("port 0 is outside 1-65535")
            expect(connectionUrlProblem("not a url")).toBe("is not a valid URL")
            expect(connectionUrlProblem("ftp://node.example.com:21")).toBe("is not an http or https URL")
            expect(connectionUrlProblem("")).toBe("must be null or a non-empty string")
            expect(connectionUrlProblem(53550)).toBe("must be null or a non-empty string")
            for (const ok of [null, "https://node2.demos.sh", "http://45.13.233.189:65535", "http://[::1]:53550/"]) {
                expect([ok, connectionUrlProblem(ok)]).toEqual([ok, null])
            }

            const validators = many(7)
            validators[2] = validator(3, "http://45.13.233.189:65550")
            const { connection_url: _, ...noUrl } = validator(4)
            validators[3] = noUrl as ReturnType<typeof validator>
            const problems = genesisNetworkProblems(network(10, validators))
            expect(problems).toEqual([
                `validators[2] (${validator(3).address}) connection_url "http://45.13.233.189:65550" port 65550 is outside 1-65535`,
                `validators[3] (${validator(4).address}) connection_url undefined must be null or a non-empty string`,
            ])
        })

        it("fails the command line on them and answers --help", () => {
            const g = network(10, many(7))
            g.validators[0] = validator(1, "http://45.13.233.189:65550")
            const file = writeGenesis(g)
            const run = Bun.spawnSync(["bun", "scripts/genesis-hash.ts", "--genesis", file], {
                stdout: "pipe",
                stderr: "pipe",
                env: { ...process.env, DEMOS_SNAPSHOT_DIR: "" },
            })
            expect(run.exitCode).toBe(1)
            expect(run.stdout.toString()).toContain("connection_url \"http://45.13.233.189:65550\" port 65550 is outside 1-65535")

            const help = Bun.spawnSync(["bun", "scripts/genesis-hash.ts", "--help"], { stdout: "pipe", stderr: "pipe" })
            expect(help.exitCode).toBe(0)
            expect(help.stdout.toString()).toContain("usage: bun scripts/genesis-hash.ts --genesis FILE")
        }, 60_000)

        it("--allow-unforgeable turns only the quorum finding into a warning", () => {
            const unforgeable = network(10, many(4))
            expect(genesisNetworkFindings(unforgeable).problems).toEqual([])
            expect(genesisNetworkFindings(unforgeable).unforgeable[0]).toStartWith(
                "4 validators in genesis validators, below the quorum of 7",
            )
            expect(parseArgs(["--genesis", "g.json", "--allow-unforgeable"], {}).allowUnforgeable).toBe(true)
            expect(parseArgs(["--genesis", "g.json"], {}).allowUnforgeable).toBe(false)

            const env = { ...process.env, DEMOS_SNAPSHOT_DIR: "" }
            const file = writeGenesis(unforgeable)
            const strict = Bun.spawnSync(["bun", "scripts/genesis-hash.ts", "--genesis", file, "--json"], {
                stdout: "pipe",
                stderr: "pipe",
                env,
            })
            expect(strict.exitCode).toBe(1)
            const allowed = Bun.spawnSync(
                ["bun", "scripts/genesis-hash.ts", "--genesis", file, "--json", "--allow-unforgeable"],
                { stdout: "pipe", stderr: "pipe", env },
            )
            expect(allowed.exitCode).toBe(0)
            const out = JSON.parse(allowed.stdout.toString().slice(allowed.stdout.toString().indexOf("{")))
            expect(out.problems).toEqual([])
            expect(out.warnings).toHaveLength(1)
            expect(out.warnings[0]).toStartWith("4 validators in genesis validators, below the quorum of 7")

            // What a node refuses stays a problem under the flag
            const refused = network(1, many(4))
            refused.validators[0] = validator(1, "http://45.13.233.189:65550")
            const bad = Bun.spawnSync(
                ["bun", "scripts/genesis-hash.ts", "--genesis", writeGenesis(refused), "--allow-unforgeable"],
                { stdout: "pipe", stderr: "pipe", env },
            )
            expect(bad.exitCode).toBe(1)
            const text = bad.stdout.toString()
            expect(text).toContain("problem: ")
            expect(text).toContain("a node refuses this genesis at boot")
            expect(text).toContain("port 65550 is outside 1-65535")
        }, 60_000)

        it("reads the snapshot from DEMOS_SNAPSHOT_DIR when --snapshot is not given", () => {
            expect(parseArgs(["--genesis", "g.json"], { DEMOS_SNAPSHOT_DIR: "/app/mainnet-snapshot" }).snapshot).toBe(
                "/app/mainnet-snapshot",
            )
            expect(
                parseArgs(["--genesis", "g.json", "--snapshot", "s"], { DEMOS_SNAPSHOT_DIR: "/app/mainnet-snapshot" }).snapshot,
            ).toBe("s")
            expect(parseArgs(["--genesis", "g.json"], {}).snapshot).toBeNull()
            expect(() => parseArgs(["--genesis", "g.json", "--bogus"], {})).toThrow("unknown argument --bogus")
        })
    })
})
