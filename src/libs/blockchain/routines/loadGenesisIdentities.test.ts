import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

const state = { genesisIdentities: new Set<string>() }
mock.module("@/utilities/sharedState", () => ({ getSharedState: state }))

const { default: loadGenesisIdentities } = await import("./loadGenesisIdentities")

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-ids-"))
const file = path.join(dir, "genesis.json")

afterEach(() => {
    delete process.env.DEMOS_GENESIS_FILE
})

async function load(balances: unknown[]) {
    fs.writeFileSync(file, JSON.stringify({ balances }))
    process.env.DEMOS_GENESIS_FILE = file
    await loadGenesisIdentities()
    return state.genesisIdentities
}

describe("loadGenesisIdentities", () => {
    test("compares balances as integers, not strings", async () => {
        const ids = await load([
            ["0xsmall", "9"],
            ["0xexact", "1000000000000"],
            ["0xlarge", "20000000000000"],
            ["0xnumber", 1000000000000],
        ])
        expect([...ids].sort()).toEqual(["0xexact", "0xlarge", "0xnumber"])
    })

    test("skips balances that are not integers", async () => {
        const ids = await load([
            ["0xfill", "FILL"],
            ["0xfraction", "1.5e12"],
            ["0xnull", null],
        ])
        expect(ids.size).toBe(0)
    })
})
