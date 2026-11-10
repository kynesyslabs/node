/**
 * Boot path of findGenesisBlock: a node whose genesis has a mainnet chain id
 * refuses to start unless DEMOS_REQUIRE_VALIDATORS is exactly "true" (the value
 * getShard and peerlistMerge read); test network ids are unchanged. The same
 * holds on a restart, where block 0's chain id is checked as well.
 *
 * Chain is mocked and the genesis file is a temporary copy of data/genesis.json
 * with the chain id replaced, so nothing touches a database.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, mock, setDefaultTimeout } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_FORK_CONFIG } from "src/forks/forkConfig"

// The first import of findGenesisBlock loads most of the node
setDefaultTimeout(120_000)

const REFUSAL = "DEMOS_REQUIRE_VALIDATORS is not true"
const SAVED_KEYS = [
    "PROD",
    "EXPOSED_URL",
    "EXPECTED_GENESIS_HASH",
    "DEMOS_GENESIS_FILE",
    "DEMOS_SNAPSHOT_DIR",
    "DEMOS_REQUIRE_VALIDATORS",
]
const saved = Object.fromEntries(SAVED_KEYS.map(k => [k, process.env[k]]))

// The genesis stored in block 0, or null for an empty database
let storedGenesis: unknown = null

mock.module("src/libs/blockchain/chain", () => ({
    default: {
        getGenesisBlockHash: async () => (storedGenesis === null ? null : "cd".repeat(32)),
        getGenesisBlock: async () => ({
            content: { extra: { genesisData: JSON.stringify(storedGenesis) } },
        }),
        generateGenesisBlock: async () => {
            throw new Error("reached block generation")
        },
    },
}))

let dir: string
let findGenesisBlock: () => Promise<unknown>

function genesisWith(chainId: number): Record<string, unknown> {
    const forks: Record<string, unknown> = {}
    for (const name of Object.keys(DEFAULT_FORK_CONFIG)) forks[name] = { activationHeight: null }
    forks.gasFeeSeparation = { activationHeight: null, treasuryAddress: `0x${"7".repeat(64)}` }
    const base = JSON.parse(readFileSync("data/genesis.json", "utf8"))
    return { ...base, properties: { id: chainId, shardSize: 10 }, forks }
}

function writeGenesis(chainId: number): void {
    writeFileSync(join(dir, "genesis.json"), JSON.stringify(genesisWith(chainId)))
}

async function refusalMessage(): Promise<string> {
    const failure = await findGenesisBlock().then(
        () => null,
        (e: Error) => e,
    )
    expect(failure).toBeInstanceOf(Error)
    return (failure as Error).message
}

async function bootMessage(chainId: number): Promise<string> {
    writeGenesis(chainId)
    return refusalMessage()
}

/** A restart on a block 0 with `storedChainId`; the file names the testnet, so only block 0 can trigger the check. */
async function restartMessage(storedChainId: number): Promise<string> {
    writeGenesis(1)
    storedGenesis = genesisWith(storedChainId)
    return refusalMessage()
}

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "find-genesis-validators-"))
    process.env.PROD = "true"
    process.env.EXPOSED_URL = "http://203.0.113.10:53550"
    process.env.EXPECTED_GENESIS_HASH = "ab".repeat(32)
    process.env.DEMOS_GENESIS_FILE = join(dir, "genesis.json")
    process.env.DEMOS_SNAPSHOT_DIR = join(dir, "no-snapshot")
    // Imported after the environment is set: Config reads it once
    findGenesisBlock = (await import("src/libs/blockchain/routines/findGenesisBlock")).default
})

afterEach(() => {
    delete process.env.DEMOS_REQUIRE_VALIDATORS
    storedGenesis = null
})

afterAll(() => {
    for (const key of SAVED_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
})

describe("findGenesisBlock and DEMOS_REQUIRE_VALIDATORS", () => {
    it("refuses a mainnet chain id when the variable is unset", async () => {
        delete process.env.DEMOS_REQUIRE_VALIDATORS
        const message = await bootMessage(4242)
        expect(message).toContain("Refusing to boot")
        expect(message).toContain(REFUSAL)
    })

    it("refuses a mainnet chain id when the variable is false", async () => {
        process.env.DEMOS_REQUIRE_VALIDATORS = "false"
        expect(await bootMessage(4242)).toContain(REFUSAL)
    })

    it("gets past the check on a mainnet chain id when the variable is true", async () => {
        process.env.DEMOS_REQUIRE_VALIDATORS = "true"
        expect(await bootMessage(4242)).not.toContain(REFUSAL)
    })

    it("does not apply the check to the testnet or the devnet", async () => {
        delete process.env.DEMOS_REQUIRE_VALIDATORS
        for (const id of [1, 1337]) {
            expect(await bootMessage(id)).not.toContain(REFUSAL)
        }
    })
})

describe("findGenesisBlock on a stored block 0 and DEMOS_REQUIRE_VALIDATORS", () => {
    it("refuses a block 0 on a mainnet chain id when the variable is unset", async () => {
        delete process.env.DEMOS_REQUIRE_VALIDATORS
        const message = await restartMessage(4242)
        expect(message).toContain("Refusing to boot")
        expect(message).toContain(REFUSAL)
    })

    it("gets past the check on a block 0 with a mainnet chain id when the variable is true", async () => {
        process.env.DEMOS_REQUIRE_VALIDATORS = "true"
        const message = await restartMessage(4242)
        expect(message).not.toContain(REFUSAL)
        // A later check that reads block 0's chain id
        expect(message).toContain("data/genesis.json has chain id 1, block 0 has 4242")
    })

    it("never refuses a block 0 on the testnet chain id", async () => {
        for (const value of [undefined, "false"]) {
            if (value === undefined) delete process.env.DEMOS_REQUIRE_VALIDATORS
            else process.env.DEMOS_REQUIRE_VALIDATORS = value
            const message = await restartMessage(1)
            expect(message).not.toContain(REFUSAL)
            // The restart got as far as comparing block 0 with the pin
            expect(message).toContain("the genesis in this database hashes to")
        }
    })
})
