/**
 * The mainnet genesis template and the launch validator table rules
 * (--plan): what can be checked before any validator is up.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    KNOWN_FORKS,
    LAUNCH_DORMANT_FORKS,
    LAUNCH_SHARD_SIZE,
    MAINNET_FORKS,
    NON_MAINNET_CHAIN_IDS,
    launchGenesisExpectations,
    launchPlanChecks,
    mainnetGenesisReasons,
    validatorTable,
} from "./launch-go-no-go"

const ROOT = join(import.meta.dir, "..")
const TEMPLATE = join(ROOT, "docs/mainnet/genesis.template.json")
const readTemplate = () => JSON.parse(readFileSync(TEMPLATE, "utf8"))
const id = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0")
const isFill = (v: unknown) => typeof v === "string" && v.startsWith("FILL")

/** The template with every FILL field given a value, as the owners would. */
function filledTemplate(validators = 10) {
    const g = readTemplate()
    g.properties.id = 7
    g.properties.name = "DEMOS-MAINNET-TEST"
    g.properties.currency = "DEM"
    delete g.properties.sudoPubkey
    g.forks.gasFeeSeparation = { activationHeight: 0, treasuryAddress: "0x" + "ab".repeat(32) }
    g.forks.web2ProofBinding = { activationHeight: null }
    g.forks.tlsnProofEnforcement = { activationHeight: null }
    delete g.snapshot
    g.balances = []
    g.timestamp = "1793318400"
    g.validators = Array.from({ length: validators }, (_, i) => ({
        address: id(i),
        status: "2",
        connection_url: `http://v${i}.example:53550`,
        staked_amount: "1000000000000000000",
        first_seen: 0,
        valid_at: 0,
    }))
    return g
}

const blockZero = (n: number) => ({
    rows: Array.from({ length: n }, (_, i) => ({ address: id(i), status: "2", valid_at: 0 })),
    source: "genesis" as const,
    reasons: [],
    warnings: [],
})

/** n validators, at most three per operator and per provider, each with a region. */
function table(n: number, edit: (i: number) => Record<string, string> = () => ({})) {
    return Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
            id(i),
            { operator: `op-${i % 4}`, provider: `cloud-${i % 4}`, region: `region-${i % 3}`, ...edit(i) },
        ]),
    )
}

const failing = (checks: ReturnType<typeof launchPlanChecks>) => checks.filter(c => !c.ok).map(c => c.name)

describe("mainnet genesis template", () => {
    it("schedules every mainnet fork at block 0", () => {
        const forks = readTemplate().forks
        for (const name of MAINNET_FORKS) {
            const { treasuryAddress, ...schedule } = forks[name]
            expect(schedule).toEqual({ activationHeight: 0 })
            // Only gasFeeSeparation carries a payload: the treasury the owners fill
            expect(treasuryAddress === undefined || name === "gasFeeSeparation").toBe(true)
        }
    })

    it("declares every fork this build knows and no other", () => {
        expect(Object.keys(readTemplate().forks).sort()).toEqual([...KNOWN_FORKS].sort())
    })

    it("leaves the owners' decisions as FILL values the node refuses to load", async () => {
        const g = readTemplate()
        for (const v of [
            g.properties.id,
            g.forks.gasFeeSeparation.treasuryAddress,
            g.forks.web2ProofBinding.activationHeight,
            g.forks.tlsnProofEnforcement.activationHeight,
            g.balances,
            g.timestamp,
            g.validators,
        ]) {
            expect(isFill(v)).toBe(true)
        }
        await expect(launchGenesisExpectations(g)).rejects.toThrow()
    })

    it("pins no identity and no chain id", () => {
        const text = readFileSync(TEMPLATE, "utf8")
        expect(text).not.toMatch(/0x[0-9a-f]{64}/)
    })

    it("once filled, passes the genesis checks and loads as a node loads it", async () => {
        const g = filledTemplate()
        expect(mainnetGenesisReasons(g)).toEqual([])
        const e = await launchGenesisExpectations(g)
        expect(e.genesisFileProblems).toEqual([])
        expect(e.genesisFileBlockHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it("refuses a placeholder treasury that block 0 would migrate, unless the snapshot carries the fork", async () => {
        const g = filledTemplate()
        g.forks.gasFeeSeparation = { activationHeight: null, treasuryAddress: "0x" + "0".repeat(64) }
        // The loader accepts the zero address on a null height
        expect((await launchGenesisExpectations(g)).genesisFileProblems).toEqual([])

        const fresh = await launchGenesisExpectations(g, null, [])
        expect(fresh.genesisFileProblems.join("\n")).toContain("treasuryAddress equals BURN_ADDRESS")

        const carried = await launchGenesisExpectations(g, null, [{ fork_name: "gasFeeSeparation", applied: true }])
        expect(carried.genesisFileProblems).toEqual([])
    })

    it("refuses an OS-unit snapshot under a genesis that activates osDenomination later", async () => {
        const g = filledTemplate()
        g.forks.osDenomination = { activationHeight: 100 }
        const e = await launchGenesisExpectations(g, null, [{ fork_name: "osDenomination", applied: true }])
        expect(e.genesisFileProblems.join("\n")).toContain("the snapshot is already in OS units")
    })

    it("lists the same mainnet forks as the genesis acceptance harness", () => {
        const sh = readFileSync(join(ROOT, "testing/genesis-acceptance/run.sh"), "utf8")
        const py = readFileSync(join(ROOT, "testing/genesis-acceptance/fixtures.py"), "utf8")
        const fromSh = /^MAINNET_FORKS="([^"]*)"/m.exec(sh)?.[1].split(/\s+/)
        const fromPy = /^MAINNET_FORKS = \[([^\]]*)\]/m.exec(py)?.[1].split(",").map(s => s.trim().replace(/"/g, ""))
        expect(fromSh).toEqual([...MAINNET_FORKS])
        expect(fromPy).toEqual([...MAINNET_FORKS])
        // The harness's launch genesis must declare every fork, or the node
        // refuses it on the mainnet-shaped chain id
        const knownPy = /^KNOWN_FORKS = \[([^\]]*)\]/m.exec(py)?.[1].split(",").map(s => s.trim().replace(/"/g, ""))
        expect(knownPy).toEqual([...KNOWN_FORKS])
        const dormantPy = /^LAUNCH_DORMANT_FORKS = \[([^\]]*)\]/m.exec(py)?.[1].split(",").map(s => s.trim().replace(/"/g, ""))
        expect(dormantPy).toEqual([...LAUNCH_DORMANT_FORKS])
    })
})

describe("mainnetGenesisReasons", () => {
    it("refuses template FILL values left anywhere in the file", () => {
        const g = filledTemplate()
        g.properties.name = "FILL: network name (testnet: DEMOS)"
        g.properties.currency = "FILL: currency symbol (testnet: DEM)"
        const reasons = mainnetGenesisReasons(g).join("\n")
        expect(reasons).toContain("genesis.properties.name")
        expect(reasons).toContain("genesis.properties.currency")
        expect(mainnetGenesisReasons(readTemplate()).join("\n")).toContain("template FILL values")
    })

    it("refuses the testnet and devnet chain ids, and a missing one", () => {
        for (const chainId of NON_MAINNET_CHAIN_IDS) {
            const g = filledTemplate()
            g.properties.id = chainId
            expect(mainnetGenesisReasons(g).join("\n")).toContain(`properties.id ${chainId} is the chain id of the testnet`)
        }
        const g = filledTemplate()
        delete g.properties.id
        expect(mainnetGenesisReasons(g).join("\n")).toContain("must be the agreed mainnet chain id")
    })

    it(`refuses a shardSize other than ${LAUNCH_SHARD_SIZE}`, () => {
        for (const shardSize of [4, 13, "10"]) {
            const g = filledTemplate()
            g.properties.shardSize = shardSize
            expect(mainnetGenesisReasons(g).join("\n")).toContain(`the launch committee size is ${LAUNCH_SHARD_SIZE}`)
        }
    })

    it("refuses a fork left undeclared, since it would take the code default", () => {
        for (const name of KNOWN_FORKS) {
            const g = filledTemplate()
            delete g.forks[name]
            expect(mainnetGenesisReasons(g).join("\n")).toContain(`the genesis does not declare ${name}`)
        }
    })

    it("refuses a scheduled gasFeeSeparation without its own treasury", () => {
        const g = filledTemplate()
        g.forks.gasFeeSeparation = { activationHeight: 0 }
        expect(mainnetGenesisReasons(g).join("\n")).toContain("without a treasuryAddress")
    })

    it("refuses a scheduled gasFeeSeparation whose treasury the node would refuse", () => {
        for (const [treasuryAddress, why] of [
            ["0x" + "AB".repeat(32), "must match"],
            ["0x" + "ab".repeat(31), "must match"],
            ["ab".repeat(32), "must match"],
            ["0x" + "0".repeat(64), "equals BURN_ADDRESS"],
        ]) {
            const g = filledTemplate()
            g.forks.gasFeeSeparation = { activationHeight: 0, treasuryAddress }
            const reasons = mainnetGenesisReasons(g).join("\n")
            expect(reasons).toContain("scheduled with a treasuryAddress the node refuses")
            expect(reasons).toContain(why)
        }
        expect(mainnetGenesisReasons(filledTemplate()).join("\n")).not.toContain("treasuryAddress")
    })

    it("refuses a genesis that leaves gasFeeSeparation off, where a transfer pays a flat gas no account receives", () => {
        const g = filledTemplate()
        g.forks.gasFeeSeparation.activationHeight = null
        expect(mainnetGenesisReasons(g)).toEqual([
            "fork gasFeeSeparation is not scheduled at activationHeight 0 in the genesis (found null)",
        ])
    })
})

describe("validator table", () => {
    it("passes ten validators spread three or fewer per operator and provider", () => {
        const checks = launchPlanChecks({
            genesis: filledTemplate(),
            blockZero: blockZero(10),
            shardSize: 10,
            operators: table(10),
            genesisFileProblems: [],
        })
        expect(failing(checks)).toEqual([])
    })

    it("fails a genesis whose name and currency are still template FILL values", () => {
        const g = filledTemplate()
        g.properties.name = "FILL: network name (testnet: DEMOS)"
        g.properties.currency = "FILL: currency symbol (testnet: DEM)"
        const checks = launchPlanChecks({
            genesis: g,
            blockZero: blockZero(10),
            shardSize: 10,
            operators: table(10),
            genesisFileProblems: [],
        })
        expect(failing(checks)).toEqual(["genesis values"])
        const details = checks.find(c => c.name === "genesis values").details.join("\n")
        expect(details).toContain("genesis.properties.name")
        expect(details).toContain("genesis.properties.currency")
    })

    it("fails four validators of one operator: over the cap and over a third of the votes", () => {
        const checks = launchPlanChecks({
            genesis: filledTemplate(),
            blockZero: blockZero(10),
            shardSize: 10,
            operators: table(10, i => (i < 4 ? { operator: "big-op" } : { operator: `op-${i}` })),
            genesisFileProblems: [],
        })
        expect(failing(checks)).toEqual(["operator and provider cap", "voting power per operator and provider"])
        expect(checks.find(c => c.name === "voting power per operator and provider").details.join("\n")).toContain(
            "operator big-op can hold 4 of the 10 first-committee votes",
        )
    })

    it("fails four validators on one provider, whatever the spelling", () => {
        const spellings = ["AWS", "aws", " Aws ", "aws"]
        const checks = launchPlanChecks({
            genesis: filledTemplate(),
            blockZero: blockZero(10),
            shardSize: 10,
            operators: table(10, i => (i < 4 ? { provider: spellings[i] } : { provider: `cloud-${i}` })),
            genesisFileProblems: [],
        })
        expect(failing(checks)).toContain("operator and provider cap")
        expect(checks.find(c => c.name === "operator and provider cap").details.join("\n")).toContain("provider aws runs 4 of 10")
    })

    it("fails a row without a region or without an entry", () => {
        const ops = table(10)
        delete (ops[id(2)] as Record<string, string>).region
        delete ops[id(3)]
        const checks = launchPlanChecks({ genesis: filledTemplate(), blockZero: blockZero(10), shardSize: 10, operators: ops, genesisFileProblems: [] })
        expect(failing(checks)).toEqual(["validator table"])
        const details = checks.find(c => c.name === "validator table").details.join("\n")
        expect(details).toContain(`have no region: ${id(2)}`)
        expect(details).toContain(`no operator/provider entry: ${id(3)}`)
    })

    it("fails fewer launch validators than the quorum", () => {
        const checks = launchPlanChecks({ genesis: filledTemplate(6), blockZero: blockZero(6), shardSize: 10, operators: table(6), genesisFileProblems: [] })
        expect(failing(checks)).toContain("launch validators")
    })

    it("reports each failed genesis rule on its own line", () => {
        const g = filledTemplate()
        g.properties.id = 1
        g.properties.shardSize = 4
        g.forks.commitLock = { activationHeight: null }
        const checks = launchPlanChecks({ genesis: g, blockZero: blockZero(10), shardSize: 4, operators: table(10), genesisFileProblems: ["x"] })
        expect(failing(checks)).toEqual(
            expect.arrayContaining(["genesis forks", "chain id", "shard size", "genesis file"]),
        )
    })

    it("only warns about a missing region at T-0, where the table was already checked", () => {
        const ops = table(10)
        delete (ops[id(0)] as Record<string, string>).region
        const t = validatorTable(Array.from({ length: 10 }, (_, i) => id(i)), ops, 10)
        expect(t.reasons).toEqual([])
        expect(t.warnings.join("\n")).toContain("no region")
    })
})

describe("command line --plan", () => {
    const run = (args: string[]) => {
        const r = Bun.spawnSync(["bun", "scripts/launch-go-no-go.ts", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
        return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
    }

    it("needs the snapshot and the operator table", () => {
        const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
        const { tmpdir } = require("node:os") as typeof import("node:os")
        const file = join(mkdtempSync(join(tmpdir(), "go-no-go-plan-")), "genesis.json")
        writeFileSync(file, JSON.stringify(filledTemplate()))
        const r = run(["--plan", "--genesis", file])
        expect(r.code).toBe(2)
        expect(r.err).toContain("--plan needs --genesis, --snapshot and --operators")
    }, 60_000)
})
