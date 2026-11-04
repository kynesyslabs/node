import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import {
    GENESIS_DELAY_S,
    drillOverrideYaml,
    genesisTimestamp,
    peerSeedFromGenesis,
    stageDrillInputs,
} from "./lib/drillInputs"

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
const PUBKEYS = [key(0xa1), key(0xa2), key(0xa3), key(0xa4)]
const PORTS = ["53551", "53553", "53555", "53557"]

function genesis(): Record<string, any> {
    return {
        properties: { id: 1, name: "DEMOS", shardSize: 4 },
        balances: [[PUBKEYS[0], "1000000000000000000"]],
        timestamp: "1692734616",
        forks: { osDenomination: { activationHeight: 5 } },
        validators: PUBKEYS.map((address, i) => ({
            address,
            status: "2",
            connection_url: `http://node-${i + 1}:${PORTS[i]}`,
            staked_amount: "1000000000000000000",
            first_seen: 0,
            valid_at: 0,
        })),
    }
}

let dir: string
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drill-inputs-test-"))
})
afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe("genesisTimestamp", () => {
    it("is the delay after the given time, in whole seconds", () => {
        expect(GENESIS_DELAY_S).toBe(60)
        expect(genesisTimestamp(1_700_000_000_999)).toBe(1_700_000_060)
    })
    it("is in the future of the moment it was computed", () => {
        expect(genesisTimestamp(Date.now())).toBeGreaterThan(Math.floor(Date.now() / 1_000))
    })
})

describe("peerSeedFromGenesis", () => {
    it("returns the pubkeys in node order and node-1's port", () => {
        expect(peerSeedFromGenesis(genesis())).toEqual({ pubkeys: PUBKEYS, node1Port: "53551" })
    })
    it("rejects a genesis without validators", () => {
        expect(() => peerSeedFromGenesis({ ...genesis(), validators: [] })).toThrow(/no validators/)
        expect(() => peerSeedFromGenesis({})).toThrow(/no validators/)
    })
})

describe("stageDrillInputs (drill_inputs.py)", () => {
    it("sets the genesis time in the future and keeps the rest of the genesis", () => {
        const before = Math.floor(Date.now() / 1_000)
        const ts = genesisTimestamp(Date.now())
        const staged = stageDrillInputs({ genesis: genesis(), genesisTs: ts, dir })
        const out = JSON.parse(readFileSync(staged.genesis, "utf8"))
        expect(out.timestamp).toBe(ts)
        expect(out.timestamp).toBeGreaterThan(before)
        const { timestamp: _a, ...rest } = out
        const { timestamp: _b, ...expected } = genesis()
        expect(rest).toEqual(expected)
    })
    it("writes a peerlist that seeds node-1 only", () => {
        const staged = stageDrillInputs({ genesis: genesis(), genesisTs: 1_800_000_000, dir })
        expect(JSON.parse(readFileSync(staged.peerlist, "utf8"))).toEqual({
            [PUBKEYS[0]]: "http://node-1:53551",
        })
    })
    it("creates an empty directory for the snapshot mount", () => {
        const staged = stageDrillInputs({ genesis: genesis(), genesisTs: 1_800_000_000, dir })
        expect(statSync(staged.emptySnapshot).isDirectory()).toBe(true)
        expect(readdirSync(staged.emptySnapshot)).toEqual([])
    })
    it("fails loudly on a genesis it cannot stage", () => {
        expect(() => stageDrillInputs({ genesis: {}, genesisTs: 1, dir })).toThrow(/no validators/)
    })
})

describe("drillOverrideYaml", () => {
    const staged = {
        dir: "/stage",
        genesis: "/stage/genesis.json",
        peerlist: "/stage/peerlist.json",
        emptySnapshot: "/stage/empty-snapshot",
    }
    const yaml = drillOverrideYaml(staged, [1, 2, 3, 4])

    it("mounts the empty snapshot over /app/data/snapshot on every node", () => {
        const mounts = yaml.split("\n").filter(l => l.includes(":/app/data/snapshot:ro"))
        expect(mounts).toEqual(
            Array(4).fill("      - \"/stage/empty-snapshot:/app/data/snapshot:ro\""),
        )
    })
    it("mounts the node-1-only peerlist where the base compose mounts its own", () => {
        const mounts = yaml.split("\n").filter(l => l.includes(":/app/demos_peerlist.json:ro"))
        expect(mounts).toHaveLength(4)
        expect(mounts[0]).toContain("\"/stage/peerlist.json:")
    })
    it("mounts the staged genesis over /app/data/genesis.json", () => {
        expect(yaml.match(/"\/stage\/genesis\.json:\/app\/data\/genesis\.json:ro"/g)).toHaveLength(4)
    })
    it("has one service block per node and nothing else", () => {
        expect(yaml.split("\n").filter(l => /^ {2}\S/.test(l))).toEqual([
            "  node-1:",
            "  node-2:",
            "  node-3:",
            "  node-4:",
        ])
        expect(yaml.startsWith("services:\n")).toBe(true)
    })
    it("refuses a path that would break the volume string", () => {
        expect(() => drillOverrideYaml({ ...staged, genesis: "/a:b/genesis.json" }, [1])).toThrow(
            /not usable/,
        )
    })
})

describe("scenario 12 wiring", () => {
    const src = readFileSync(
        resolve(import.meta.dir, "scenarios/12-quorum-loss-halt-recovery.ts"),
        "utf8",
    )
    it("restarts nodes 2-4 after up() and before the P1 baseline wait", () => {
        const upCall = src.indexOf("up({ overrideFiles")
        const restart = src.indexOf("await restartForColdStart()")
        const baseline = src.indexOf("// P1 baseline")
        expect(upCall).toBeGreaterThan(-1)
        expect(restart).toBeGreaterThan(upCall)
        expect(baseline).toBeGreaterThan(restart)
        expect(src).toContain("NODE_IDS.slice(1)")
    })
    it("removes what it staged in a finally block", () => {
        const fin = src.indexOf("} finally {")
        expect(fin).toBeGreaterThan(-1)
        const tail = src.slice(fin)
        expect(tail).toContain("clearOverride(SCENARIO_ID)")
        expect(tail).toContain("rmSync(stagingDir")
    })
    it("builds the image before it sets the genesis time", () => {
        const build = src.indexOf("compose([\"build\"])")
        expect(build).toBeGreaterThan(-1)
        expect(build).toBeLessThan(src.indexOf("genesisTimestamp(Date.now())"))
    })
})

describe("other scenarios keep the plain up()", () => {
    it("no other scenario passes override files to up()", () => {
        const scenarios = resolve(import.meta.dir, "scenarios")
        for (const f of readdirSync(scenarios)) {
            if (f.startsWith("12-")) continue
            expect(readFileSync(join(scenarios, f), "utf8")).not.toContain("overrideFiles")
        }
    })
})
