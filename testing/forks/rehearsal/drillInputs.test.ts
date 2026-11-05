import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { loadForkConfigFromGenesis } from "@/forks/loadForkConfig"
import { getSharedState } from "@/utilities/sharedState"
import {
    GENESIS_DELAY_S,
    LAUNCH_GENESIS_TEMPLATE,
    bootRefusalLine,
    drillOverrideYaml,
    genesisTimestamp,
    launchExcluded,
    peerSeedFromGenesis,
    stageDrillInputs,
    withLaunchForks,
} from "./lib/drillInputs"
import { systemBinary } from "./lib/systemBinary"

const REASON = "needs a genesis snapshot; the drills use the legacy genesis path"

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

describe("bootRefusalLine", () => {
    it("returns the last refusal line of a node log, and null when there is none", () => {
        const log = [
            "[INFO] [GENESIS] Looking for the genesis block...",
            "[ERROR] [GENESIS] Refusing to boot: identityCarryover is active at genesis but no snapshot was found",
            "[INFO] restarting",
            "[ERROR] [GENESIS] Refusing to boot: second attempt  ",
        ].join("\n")
        expect(bootRefusalLine(log)).toBe("[ERROR] [GENESIS] Refusing to boot: second attempt")
        expect(bootRefusalLine("[INFO] [GENESIS] Genesis block found\n")).toBeNull()
        expect(bootRefusalLine("")).toBeNull()
    })
})

describe("node tmpfs options (drill_inputs.py tmpfs)", () => {
    const script = resolve(import.meta.dir, "../../devnet/quorum-drills/drill_inputs.py")
    const run = (...args: string[]) => spawnSync(systemBinary("python3"), ["-I", script, "tmpfs", ...args], { encoding: "utf8" })

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
    const yaml = drillOverrideYaml(staged, [1, 2, 3, 4], { consensusTimeS: 7 })

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
        expect(() =>
            drillOverrideYaml({ ...staged, genesis: "/a:b/genesis.json" }, [1], { consensusTimeS: 10 }),
        ).toThrow(/not usable/)
    })
    it("sets every node's CONSENSUS_TIME to the drill's value, not the devnet .env", () => {
        expect(yaml.split("\n").filter(l => l.includes("CONSENSUS_TIME"))).toEqual(
            Array(4).fill("      - CONSENSUS_TIME=7"),
        )
    })
    it("refuses a consensus time compose would not take as whole seconds", () => {
        for (const bad of [0, -1, 2.5, Number.NaN]) {
            expect(() => drillOverrideYaml(staged, [1], { consensusTimeS: bad })).toThrow(/positive whole/)
        }
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

    it("activates at 0 only the forks the real template sets to the number 0, except identityCarryover", () => {
        const real = JSON.parse(readFileSync(LAUNCH_GENESIS_TEMPLATE, "utf8")).forks
        const expected = Object.fromEntries(
            Object.entries<any>(real).map(([n, f]) => [n, f.activationHeight === 0 && n !== "identityCarryover" ? 0 : null]),
        )
        expect(heights(withLaunchForks(genesis()))).toEqual(expected)
        // 15 forks in the template, all of them in the genesis; identityCarryover is explicitly off
        expect(Object.keys(expected)).toHaveLength(15)
        expect(withLaunchForks(genesis()).forks.identityCarryover).toEqual({ activationHeight: null })
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
    describe("excluded forks", () => {
        it("sets identityCarryover to an explicit null when the template has it at 0, and the rest of the set is unchanged", () => {
            const g = withLaunchForks(genesis(), template({ ...MIN, identityCarryover: { activationHeight: 0 }, osDenomination: { activationHeight: 0 } }))
            expect(g.forks.identityCarryover).toEqual({ activationHeight: null })
            expect("activationHeight" in g.forks.identityCarryover).toBe(true)
            expect(heights(g)).toEqual({ ...Object.fromEntries(Object.keys(MIN).map(n => [n, 0])), identityCarryover: null, osDenomination: 0 })
        })
        it("still works with a template that does not list it, and still turns it off explicitly", () => {
            const g = withLaunchForks(genesis(), template(MIN))
            expect(heights(g)).toEqual({ ...Object.fromEntries(Object.keys(MIN).map(n => [n, 0])), identityCarryover: null })
            expect(launchExcluded(template(MIN))).toEqual({})
        })
        it("turns it off whatever the template says, and a genesis of its own that has it at 0 does not keep it", () => {
            for (const h of [0, null, 7, "FILL: 0 or null"]) {
                const own = { ...genesis(), forks: { identityCarryover: { activationHeight: 0 } } }
                expect(withLaunchForks(own, template({ ...MIN, identityCarryover: { activationHeight: h } })).forks.identityCarryover).toEqual({ activationHeight: null })
            }
        })
        it("reports the exclusion, with its reason, only when the template activates the fork", () => {
            expect(launchExcluded(template({ ...MIN, identityCarryover: { activationHeight: 0 } }))).toEqual({ identityCarryover: REASON })
            expect(launchExcluded(template({ ...MIN, identityCarryover: { activationHeight: null } }))).toEqual({})
            expect(launchExcluded(template({ ...MIN, identityCarryover: { activationHeight: "FILL: 0 or null" } }))).toEqual({})
            expect(launchExcluded(LAUNCH_GENESIS_TEMPLATE)).toEqual(
                JSON.parse(readFileSync(LAUNCH_GENESIS_TEMPLATE, "utf8")).forks.identityCarryover?.activationHeight === 0 ? { identityCarryover: REASON } : {},
            )
            expect(() => launchExcluded(template({}))).toThrow(/launch-excluded failed/)
        })
        it("only names forks the node knows, so a typo in the list cannot hide one", () => {
            // every fork the node has, each at 0 in turn: the excluded ones are the ones that come back
            const known = Object.keys(cloneDefaultForkConfig())
            expect(known).toContain("identityCarryover")
            const excluded = known.filter(n => Object.keys(launchExcluded(template({ ...MIN, [n]: { activationHeight: 0 } }))).includes(n))
            expect(excluded).toEqual(["identityCarryover"])
        })
        it("a genesis the launch set built loads: 15 forks, identityCarryover off, the other nine at 0", () => {
            const saved = getSharedState.forkConfig
            try {
                for (const base of [genesis(), JSON.parse(readFileSync(resolve(import.meta.dir, "../../devnet/genesis.devnet.json"), "utf8"))]) {
                    const g = withLaunchForks(base)
                    expect(Object.keys(g.forks)).toHaveLength(15)
                    getSharedState.forkConfig = cloneDefaultForkConfig()
                    loadForkConfigFromGenesis(g)
                    const loaded = getSharedState.forkConfig as unknown as Record<string, { activationHeight: number | null }>
                    expect(loaded.identityCarryover.activationHeight).toBeNull()
                    expect(Object.keys(g.forks).filter(n => loaded[n].activationHeight === 0)).toHaveLength(9)
                }
            } finally {
                getSharedState.forkConfig = saved
            }
        })
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
        expect(heights(g)).toEqual({ ...Object.fromEntries(Object.keys(MIN).map(n => [n, 0])), a: null, b: null, c: null, d: null, e: null, f: null, g: null, h: null, identityCarryover: null })
    })
    it("replaces the genesis' own heights and does not leave a fork to the node's default", () => {
        const own = { ...genesis(), forks: { osDenomination: { activationHeight: 5 }, gasFeeSeparation: { activationHeight: 0, treasuryAddress: key(0xee) }, stray: { activationHeight: 3 } } }
        const g = withLaunchForks(own, template({ ...MIN, osDenomination: { activationHeight: 0 }, gasFeeSeparation: { activationHeight: "FILL: 0 or null", treasuryAddress: "FILL" } }))
        expect(heights(g)).toEqual({ ...Object.fromEntries(Object.keys(MIN).map(n => [n, 0])), osDenomination: 0, gasFeeSeparation: null, identityCarryover: null })
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
        const gen = (forkSet: string | null, binding = "on", nodes = 4) => {
            const run = join(dir, `run-${forkSet}-${binding}-${nodes}`)
            mkdirSync(join(run, "inputs"), { recursive: true })
            for (let i = 0; i < nodes; i++) writeFileSync(join(run, "inputs", `pub${i + 1}`), key(0xa1 + i))
            const r = spawnSync(
                systemBinary("python3"),
                [
                    // no -I, as run.sh: the script imports drill_inputs from its own directory
                    resolve(repo, "testing/devnet/quorum-drills/gen-inputs.py"),
                    "--run-dir", run, "--repo", repo, "--nodes", String(nodes), "--shard-size", "10", "--binding", binding,
                    "--genesis-ts", "1", "--image", "img", "--uid", "1000", "--gid", "1000",
                    "--node-mem", "1g", "--consensus-time", "10",
                    ...(forkSet ? ["--fork-set", forkSet] : []),
                ],
                { encoding: "utf8" },
            )
            return {
                r,
                genesis: r.status === 0 ? JSON.parse(readFileSync(join(run, "inputs/genesis.json"), "utf8")) : null,
                compose: r.status === 0 ? JSON.parse(readFileSync(join(run, "compose.yml"), "utf8")) : null,
            }
        }
        it("starts the shared postgres with max_connections of at least 10 per node + 20, for 4, 10 and 13 nodes", () => {
            // 10 = the TypeORM pool's default (src/model/datasource.ts sets no max); 20 = reserved
            // superuser slots, the harness' psql reads, the healthcheck. The compose has twice the pools.
            for (const [nodes, configured] of [[4, 100], [10, 220], [13, 280]] as const) {
                const { r, compose } = gen(null, "on", nodes)
                expect(r.status).toBe(0)
                expect(Object.keys(compose.services).filter(s => s.startsWith("node-"))).toHaveLength(nodes)
                const cmd: string[] = compose.services.postgres.command
                expect(cmd.slice(0, 2)).toEqual(["postgres", "-c"])
                const m = Number(cmd[2].match(/^max_connections=(\d+)$/)?.[1])
                expect(m).toBe(configured)
                expect(m).toBeGreaterThanOrEqual(10 * nodes + 20)
                // 13 nodes were the case the default of 100 could not hold
                if (nodes === 13) expect(m).toBeGreaterThan(100)
            }
        })
        it("keeps the postgres image, its 1g memory limit, tmpfs and healthcheck as they were at 13 nodes", () => {
            const { compose } = gen(null, "on", 13)
            const { command: _command, ...pg } = compose.services.postgres
            expect(pg).toMatchObject({ image: "postgres:16-alpine", mem_limit: "1g", memswap_limit: "1g", tmpfs: ["/var/lib/postgresql/data"] })
            expect(pg.healthcheck.test).toEqual(["CMD-SHELL", "pg_isready -U demosuser -d postgres"])
        })
        it("drill_inputs.py pgconn prints the needed and the configured value the compose uses", () => {
            const script = resolve(repo, "testing/devnet/quorum-drills/drill_inputs.py")
            for (const [nodes, need, configured] of [[4, 60, 100], [10, 120, 220], [13, 150, 280]] as const) {
                const r = spawnSync(systemBinary("python3"), ["-I", script, "pgconn", "--nodes", String(nodes)], {
                    encoding: "utf8",
                })
                expect(r.stdout.trim()).toBe(`${need} ${configured}`)
            }
        })
        it("--fork-set launch writes the same forks scenario 12 gets", () => {
            const { r, genesis: g } = gen("launch")
            expect(r.status).toBe(0)
            expect(r.stdout).toMatch(/launch fork set .*finalityProofs@0.* \| off: identityCarryover, gasFeeSeparation/)
            expect(r.stdout).toContain(`| excluded: identityCarryover (${REASON})`)
            // the list run.sh logs and records is the one scenario 12 reads
            const written = JSON.parse(readFileSync(join(dir, "run-launch-on-4", "inputs", "launch-excluded.json"), "utf8"))
            expect(written).toEqual(launchExcluded())
            expect(g.forks.identityCarryover).toEqual({ activationHeight: null })
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
                // no exclusion list for the other scenarios
                expect(existsSync(join(dir, `run-${forkSet}-${binding}-4`, "inputs", "launch-excluded.json"))).toBe(false)
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
    it("logs the excluded forks on the forks line and records them in the judge input and verdict.json", () => {
        // read from the generated inputs, so the list has one source (drill_inputs.py)
        expect(sh).toContain("EXCLUDED_FORKS=$(jq -c . \"${RUN_DIR}/inputs/launch-excluded.json\")")
        expect(sh).toMatch(/say "forks \(\$\{FORK_SET\}\): .*\$\{excluded_note\}"/)
        expect(sh).toContain("excluded_note=\"; excluded: $(jq -r ")
        expect(sh).toContain("--argjson excluded \"${EXCLUDED_FORKS}\"")
        expect(sh).toContain("excludedForks: $excluded")
        expect(sh).toContain("{excludedForks: $excluded}")
    })
    it("ends a node that never served with exit 2 and the node's own refusal line", () => {
        expect(sh).toMatch(/start_node "\$\{i\}" \|\| \{ say "ABORT: node-\$\{i\} did not serve within 180s"; why=\$\(boot_failure_line "\$\{i\}"\); \[ -n "\$\{why\}" \] && say "node-\$\{i\} log: \$\{why\}"; exit 2; \}/)
        expect(sh.indexOf("boot_failure_line() {")).toBeLessThan(sh.indexOf("# ── 3. bring-up"))
        expect(sh).toContain("grep -aiE 'refusing to boot'")
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
        // the exclusions come from drill_inputs.py too, and are logged and reported
        expect(src).toContain("launchExcluded()")
        expect(src).toMatch(/`excluded: \$\{excludedText\}\\n`/)
        expect(src).toMatch(/const line = \{[^}]*\n {8}excludedForks,\n {8}forks,\n {4}\}/)
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
