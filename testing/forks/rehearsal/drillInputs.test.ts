import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import {
    GENESIS_DELAY_S,
    LAUNCH_GENESIS_TEMPLATE,
    drillOverrideYaml,
    genesisTimestamp,
    peerSeedFromGenesis,
    stageDrillInputs,
    withLaunchForks,
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
    it("makes the staged files readable by any uid, whatever the umask", () => {
        const mode = (p: string) => statSync(p).mode & 0o777
        const before = process.umask(0o077)
        try {
            const staged = stageDrillInputs({ genesis: genesis(), genesisTs: 1_800_000_000, dir })
            expect(mode(staged.genesis)).toBe(0o644)
            expect(mode(staged.peerlist)).toBe(0o644)
            expect(mode(staged.emptySnapshot)).toBe(0o755)
            // The staging dir keeps the 0700 it was created with
            expect(mode(dir)).toBe(0o700)
        } finally {
            process.umask(before)
        }
    })
    it("fails loudly on a genesis it cannot stage", () => {
        expect(() => stageDrillInputs({ genesis: {}, genesisTs: 1, dir })).toThrow(/no validators/)
    })
})

describe("node tmpfs options (drill_inputs.py tmpfs)", () => {
    const script = resolve(import.meta.dir, "../../devnet/quorum-drills/drill_inputs.py")
    const run = (...args: string[]) => spawnSync("python3", ["-I", script, "tmpfs", ...args], { encoding: "utf8" })

    it("mounts /app/state owned by the given uid and gid, owner-only", () => {
        const r = run("--uid", "1000", "--gid", "1001")
        expect(r.status).toBe(0)
        expect(r.stdout.trim().split("\n")).toEqual(["/app/state:uid=1000,gid=1001,mode=0700"])
    })
    it("needs a numeric uid and gid", () => {
        expect(run("--gid", "1000").status).not.toBe(0)
        expect(run("--uid", "demos", "--gid", "1000").status).not.toBe(0)
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

describe("launch fork set (drill_inputs.py launch-forks)", () => {
    const template = (forks: Record<string, unknown>) => {
        const file = join(dir, "template.json")
        writeFileSync(file, JSON.stringify({ forks }))
        return file
    }
    const MIN = {
        quorumParity: { activationHeight: 0 },
        committeeBinding: { activationHeight: 0 },
        commitLock: { activationHeight: 0 },
    }
    const heights = (g: Record<string, any>) =>
        Object.fromEntries(Object.entries<any>(g.forks).map(([n, f]) => [n, f.activationHeight]))

    it("activates at 0 only the forks the real template sets to the number 0", () => {
        const real = JSON.parse(readFileSync(LAUNCH_GENESIS_TEMPLATE, "utf8")).forks
        const expected = Object.fromEntries(
            Object.entries<any>(real).map(([n, f]) => [n, f.activationHeight === 0 ? 0 : null]),
        )
        expect(heights(withLaunchForks(genesis()))).toEqual(expected)
        // The launch set the PR names: nine forks at 0, none of the FILL or null ones
        for (const n of [
            "osDenomination", "nonceEnforcement", "signatureDomain", "editBinding", "nonceIntegrity",
            "quorumParity", "committeeBinding", "commitLock", "finalityProofs",
        ]) {
            expect(expected[n]).toBe(0)
        }
        for (const n of ["gasFeeSeparation", "web2ProofBinding", "tlsnProofEnforcement", "xmProofBinding", "atomicWork"]) {
            expect(expected[n]).toBeNull()
        }
    })
    it("keeps a fork off for null, a FILL placeholder and any value that is not the number 0", () => {
        const g = withLaunchForks(
            genesis(),
            template({
                ...MIN,
                a: { activationHeight: null },
                b: { activationHeight: "FILL: 0 or null" },
                c: { activationHeight: "0" },
                d: { activationHeight: false },
                e: { activationHeight: 7 },
                f: { activationHeight: 0.5 },
                g: {},
                h: null,
            }),
        )
        expect(heights(g)).toEqual({ ...Object.fromEntries(Object.keys(MIN).map(n => [n, 0])), a: null, b: null, c: null, d: null, e: null, f: null, g: null, h: null })
    })
    it("replaces the genesis' own heights and does not leave a fork to the node's default", () => {
        const own = { ...genesis(), forks: { osDenomination: { activationHeight: 5 }, gasFeeSeparation: { activationHeight: 0, treasuryAddress: key(0xee) }, stray: { activationHeight: 3 } } }
        const g = withLaunchForks(own, template({ ...MIN, osDenomination: { activationHeight: 0 }, gasFeeSeparation: { activationHeight: "FILL: 0 or null", treasuryAddress: "FILL" } }))
        expect(heights(g)).toEqual({ ...Object.fromEntries(Object.keys(MIN).map(n => [n, 0])), osDenomination: 0, gasFeeSeparation: null })
        // an off gasFeeSeparation still carries a treasury, which the node validates
        expect(g.forks.gasFeeSeparation.treasuryAddress).toBe(key(0xee))
        expect(withLaunchForks(genesis(), template({ ...MIN, gasFeeSeparation: { activationHeight: null } })).forks.gasFeeSeparation.treasuryAddress).toMatch(/^0x0{64}$/)
    })
    it("keeps the rest of the genesis and does not modify its input", () => {
        const input = genesis()
        const g = withLaunchForks(input, template(MIN))
        expect({ ...g, forks: undefined }).toEqual({ ...input, forks: undefined })
        expect(input.forks).toEqual({ osDenomination: { activationHeight: 5 } })
    })
    it("refuses a template that drops a fork the drill's claims rest on", () => {
        for (const n of Object.keys(MIN)) {
            const { [n]: _dropped, ...rest } = MIN as Record<string, unknown>
            expect(() => withLaunchForks(genesis(), template(rest))).toThrow(new RegExp(`does not activate ${n}`))
            expect(() => withLaunchForks(genesis(), template({ ...rest, [n]: { activationHeight: "FILL: 0" } }))).toThrow(/does not activate/)
        }
        expect(() => withLaunchForks(genesis(), template({}))).toThrow(/no forks/)
        expect(() => withLaunchForks(genesis(), join(dir, "missing.json"))).toThrow(/launch-forks failed/)
    })

    describe("gen-inputs.py", () => {
        const repo = resolve(import.meta.dir, "../../..")
        const gen = (forkSet: string | null, binding = "on") => {
            const run = join(dir, `run-${forkSet}-${binding}`)
            mkdirSync(join(run, "inputs"), { recursive: true })
            PUBKEYS.forEach((p, i) => writeFileSync(join(run, "inputs", `pub${i + 1}`), p))
            const r = spawnSync(
                "python3",
                [
                    // no -I, as run.sh: the script imports drill_inputs from its own directory
                    resolve(repo, "testing/devnet/quorum-drills/gen-inputs.py"),
                    "--run-dir", run, "--repo", repo, "--nodes", "4", "--shard-size", "10", "--binding", binding,
                    "--genesis-ts", "1", "--image", "img", "--uid", "1000", "--gid", "1000",
                    "--node-mem", "1g", "--consensus-time", "10",
                    ...(forkSet ? ["--fork-set", forkSet] : []),
                ],
                { encoding: "utf8" },
            )
            return { r, genesis: r.status === 0 ? JSON.parse(readFileSync(join(run, "inputs/genesis.json"), "utf8")) : null }
        }
        it("--fork-set launch writes the same forks scenario 12 gets", () => {
            const { r, genesis: g } = gen("launch")
            expect(r.status).toBe(0)
            expect(r.stdout).toMatch(/launch fork set .*finalityProofs@0.* \| off: gasFeeSeparation/)
            const devnet = JSON.parse(readFileSync(resolve(repo, "testing/devnet/genesis.devnet.json"), "utf8"))
            expect(g.forks).toEqual(withLaunchForks(devnet).forks)
            expect(g.forks.gasFeeSeparation).toEqual({
                activationHeight: null,
                treasuryAddress: devnet.forks.gasFeeSeparation.treasuryAddress,
            })
        })
        it("the default and --fork-set devnet keep the forks of genesis.devnet.json plus the two the drills set", () => {
            const devnet = JSON.parse(readFileSync(resolve(repo, "testing/devnet/genesis.devnet.json"), "utf8"))
            for (const [forkSet, binding, committee] of [[null, "on", 0], ["devnet", "on", 0], [null, "off", null]] as const) {
                const { r, genesis: g } = gen(forkSet, binding)
                expect(r.status).toBe(0)
                expect(g.forks).toEqual({ ...devnet.forks, quorumParity: { activationHeight: 0 }, committeeBinding: { activationHeight: committee } })
            }
        })
        it("--fork-set launch refuses --binding off", () => {
            const { r } = gen("launch", "off")
            expect(r.status).not.toBe(0)
            expect(r.stderr).toMatch(/--binding must be on/)
        })
    })
})

describe("run.sh fork set", () => {
    const sh = readFileSync(resolve(import.meta.dir, "../../devnet/quorum-drills/run.sh"), "utf8")
    it("runs the launch fork set for the three mainnet-shape drills and no other scenario", () => {
        expect(sh).toMatch(/case "\$\{SCENARIO\}" in halt-n10s10\|halt-n13s10\|ride-n13s10\) FORK_SET=launch ;; esac/)
        expect(sh).toContain("--fork-set \"${FORK_SET}\"")
        expect(sh).toContain("FORK_SET=devnet\n")
    })
    it("hands the judge every fork of the genesis the nodes ran, not a fixed three", () => {
        expect(sh).toContain(".forks | with_entries(.value |= .activationHeight)")
        expect(sh).not.toContain("IN(\"quorumParity\"")
    })
})

describe("scenario 12 wiring", () => {
    const src = readFileSync(
        resolve(import.meta.dir, "scenarios/12-quorum-loss-halt-recovery.ts"),
        "utf8",
    )
    it("takes its forks from the launch template and not from a list of its own", () => {
        expect(src).toContain("withLaunchForks(genesis)")
        expect(src).not.toContain("LAUNCH_FORKS")
        // reported in the DRILL_TIMINGS line, with every fork of the genesis
        expect(src).toMatch(/const line = \{[^}]*\n {8}forks,\n {4}\}\n {4}process\.stdout\.write\(`DRILL_TIMINGS/)
    })
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
