/**
 * scripts/genesis-hash.ts publishes block 0's hash before launch. It is only
 * worth publishing if it is the hash a node builds and serves for the same
 * file, so this compares it with the node's own boot path.
 */

import { describe, it, expect } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadForkConfigFromGenesis } from "src/forks"
import { generateGenesisBlock } from "src/libs/blockchain/chainGenesis"
import { genesisValues, readGenesisFile } from "../../scripts/genesis-hash"

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
    return { ...JSON.parse(readFileSync("data/genesis.json", "utf8")), timestamp: 1793318400 }
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
})
