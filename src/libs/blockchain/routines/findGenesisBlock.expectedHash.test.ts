/**
 * Gate 3 G3-1: a node given a genesis file that differs from the published one
 * refuses to start.
 *
 * Expected interface (fits what already exists at this head):
 *   - The published hash is pinned with the existing env var
 *     EXPECTED_GENESIS_HASH, read as `Config.getInstance().core.expectedGenesisHash`
 *     (src/config/envKeys.ts, loader.ts, defaults.ts; empty string = not pinned).
 *   - The hash compared is `hashGenesisData(genesisData)` from
 *     src/libs/blockchain/genesis/normalizeGenesisForHash.ts, the same hash a
 *     node advertises to peers through `getGenesisDataHash`.
 *   - `findGenesisBlock()` (the boot-time loader called from src/index.ts) must
 *     reject when the pin is set and the hash of data/genesis.json differs from
 *     it, BEFORE `Chain.generateGenesisBlock` writes block 0.
 *
 * Today EXPECTED_GENESIS_HASH is only consulted in peerBootstrap, after block 0
 * has already been generated from the local file, and only when a peer answers.
 * A node with no reachable peer (or the first node of a network) boots on
 * whatever file it was given.
 *
 * Run: bun test src/libs/blockchain/routines/findGenesisBlock.expectedHash.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { hashGenesisData } from "src/libs/blockchain/genesis/normalizeGenesisForHash"

const GENESIS = {
    properties: { id: 1, name: "DEMOS", currency: "DEM", shardSize: 10 },
    timestamp: "1700000000000",
    balances: [["0x" + "ab".repeat(32), "1000000000000000"]],
}

const coreConfig = { restore: false, expectedGenesisHash: "" }
const sharedState: Record<string, unknown> = {}
const generateGenesisBlock = jest.fn(async () => ({ hash: "block0" }))
const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }

jest.mock("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/config", () => ({ Config: { getInstance: () => ({ core: coreConfig }) } }))
jest.mock("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getGenesisBlockHash: async () => null, generateGenesisBlock },
}))
jest.mock("src/forks", () => ({
    ForkConfigValidationError: class extends Error {},
    loadForkConfigFromGenesis: () => {},
}))
jest.mock("src/libs/consensus/genesisShardSize", () => ({
    loadShardSizeFromGenesisBlock: async () => {},
    readGenesisShardSize: () => 10,
}))
jest.mock("./beforeFindGenesisHooks", () => ({ BeforeFindGenesisHooks: class {} }))

const { default: findGenesisBlock } = await import("./findGenesisBlock")

const publishedHash = hashGenesisData(GENESIS)
/** The published hash with its last hex digit changed: differs by one character. */
const oneOff = publishedHash.slice(0, -1) + (publishedHash.endsWith("0") ? "1" : "0")

const originalCwd = process.cwd()
let workDir = ""

beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "g3-1-genesis-"))
    fs.mkdirSync(path.join(workDir, "data"))
    fs.writeFileSync(path.join(workDir, "data", "genesis.json"), JSON.stringify(GENESIS, null, 2))
    process.chdir(workDir)
})

afterAll(() => {
    process.chdir(originalCwd)
    fs.rmSync(workDir, { recursive: true, force: true })
})

beforeEach(() => {
    generateGenesisBlock.mockClear()
})

describe("findGenesisBlock with a pinned genesis hash (EXPECTED_GENESIS_HASH)", () => {
    it("loads the genesis file when it matches the published hash", async () => {
        coreConfig.expectedGenesisHash = publishedHash
        await findGenesisBlock()
        expect(generateGenesisBlock).toHaveBeenCalledTimes(1)
    })

    it("refuses to start when the genesis file does not match the published hash", async () => {
        coreConfig.expectedGenesisHash = oneOff
        let refusal: unknown = null
        try {
            await findGenesisBlock()
        } catch (e) {
            refusal = e
        }
        expect(generateGenesisBlock).not.toHaveBeenCalled()
        expect(refusal).toBeInstanceOf(Error)
        expect(String((refusal as Error).message)).toMatch(/genesis/i)
    })
})
