import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { DEFAULT_GENESIS_FILE, genesisFileExists, genesisFilePath } from "./genesisFile"
import loadGenesisIdentities from "@/libs/blockchain/routines/loadGenesisIdentities"
import { getSharedState } from "@/utilities/sharedState"

const previous = process.env.DEMOS_GENESIS_FILE

afterEach(() => {
    if (previous === undefined) delete process.env.DEMOS_GENESIS_FILE
    else process.env.DEMOS_GENESIS_FILE = previous
})

function tempGenesis(data: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-file-"))
    const file = path.join(dir, "genesis.json")
    fs.writeFileSync(file, JSON.stringify(data))
    return file
}

describe("genesisFilePath", () => {
    it("is data/genesis.json when DEMOS_GENESIS_FILE is unset or blank", () => {
        delete process.env.DEMOS_GENESIS_FILE
        expect(genesisFilePath()).toBe(DEFAULT_GENESIS_FILE)
        process.env.DEMOS_GENESIS_FILE = "  "
        expect(genesisFilePath()).toBe(DEFAULT_GENESIS_FILE)
    })

    it("resolves DEMOS_GENESIS_FILE when set", () => {
        process.env.DEMOS_GENESIS_FILE = "mainnet/genesis.json"
        expect(genesisFilePath()).toBe(path.resolve("mainnet/genesis.json"))
    })
})

describe("genesisFileExists", () => {
    it("finds the named file", () => {
        process.env.DEMOS_GENESIS_FILE = tempGenesis({ balances: [] })
        expect(genesisFileExists()).toBe(true)
    })

    it("refuses a named file that is missing instead of running without a genesis", () => {
        process.env.DEMOS_GENESIS_FILE = path.join(os.tmpdir(), "no-such-dir", "genesis.json")
        expect(() => genesisFileExists()).toThrow(/DEMOS_GENESIS_FILE points at .* which does not exist/)
    })
})

describe("readers follow DEMOS_GENESIS_FILE", () => {
    it("loadGenesisIdentities reads the named file", async () => {
        const rich = "0x" + "a".repeat(64)
        const poor = "0x" + "b".repeat(64)
        process.env.DEMOS_GENESIS_FILE = tempGenesis({
            balances: [
                [rich, "1000000000000"],
                [poor, "1"],
            ],
        })
        await loadGenesisIdentities()
        expect([...getSharedState.genesisIdentities]).toEqual([rich])
    })
})
