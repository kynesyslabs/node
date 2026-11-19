import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkLaunch, launchPlanChecks, parseArgs } from "./launch-go-no-go"
import loadGenesisIdentities from "src/libs/blockchain/routines/loadGenesisIdentities"
import { getSharedState } from "src/utilities/sharedState"

const a = "0x" + "a".repeat(64)
const b = "0x" + "b".repeat(64)
const dir = mkdtempSync(join(tmpdir(), "launch-bots-"))
const file = join(dir, "genesis.json")
const previous = process.env.DEMOS_GENESIS_FILE
const identities = getSharedState.genesisIdentities

afterEach(() => {
    if (previous === undefined) delete process.env.DEMOS_GENESIS_FILE
    else process.env.DEMOS_GENESIS_FILE = previous
    getSharedState.genesisIdentities = identities
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function botCheck(balances: unknown, botAllowlist?: unknown) {
    const checks = launchPlanChecks({
        genesis: { balances }, botAllowlist,
        blockZero: null, shardSize: 10, operators: null,
    })
    const check = checks.find(c => c.name === "bot allowlist")
    expect(check).toBeDefined()
    return check!
}

describe("launch bot allowlist", () => {
    it("shows the required bot inventory in plan help and upgrade notes", () => {
        const help = Bun.spawnSync([process.execPath, join(import.meta.dir, "launch-go-no-go.ts"), "--help"], {
            stdout: "pipe", stderr: "pipe",
        })
        expect(help.exitCode).toBe(0)
        const synopsis = help.stdout.toString().split("\n").slice(0, 5).join(" ")
        expect(synopsis).toContain("--operators FILE --bots FILE [options]")
        expect(synopsis).toContain("--bots FILE --expected-treasury ADDRESS")
        expect(synopsis).toContain("--bots FILE --expected-treasury ADDRESS --expected-notary-keys ID:HEX[,ID:HEX...]")
        expect(synopsis).toContain("launch validator table and reviewed bot inventory")

        const notes = readFileSync(join(import.meta.dir, "../docs/runbooks/release.md"), "utf8")
        const note = "`launch-go-no-go` GO and `--plan` now require `--bots FILE` (`[]` for no bots)."
        expect(notes).toContain(note)
        // Once, and for the next release: rc.11 to rc.13 shipped without --bots
        expect(notes.split(note)).toHaveLength(2)
        const next = notes.split("- From the first release after `v1.0.0-rc.13`:")[1]?.split("\n## ")[0]
        expect(next).toContain(note)
    }, 60_000)

    it("keeps the notary keys and bot checks, notary keys first, in --plan, GO and the runbook", () => {
        // No chain id counts as mainnet, so no --expected-notary-keys fails too
        const genesis = { balances: [] }
        const failed = launchPlanChecks({ genesis, botAllowlist: [a], blockZero: null, shardSize: 10, operators: null })
            .filter(c => !c.ok)
            .map(c => c.name)
        expect(failed.indexOf("notary keys")).toBeGreaterThan(-1)
        expect(failed.indexOf("notary keys")).toBeLessThan(failed.indexOf("bot allowlist"))

        const reasons = checkLaunch({
            genesis, botAllowlist: [a], blockZero: null,
            shardSize: 10, probes: [], operators: null,
        }).reasons
        const notary = reasons.findIndex(r => r.startsWith("no --expected-notary-keys given"))
        const bot = reasons.findIndex(r => r.includes(`intended bot is not authorized: ${a}`))
        expect(notary).toBeGreaterThan(-1)
        expect(notary).toBeLessThan(bot)

        const runbook = readFileSync(join(import.meta.dir, "../docs/runbooks/launch-go-no-go.md"), "utf8")
        const listed = (runbook.split("One `PASS`/`FAIL` line per check:")[1]?.split("Exit 0")[0] ?? "").replace(/\s+/g, " ")
        expect(listed.indexOf("notary keys")).toBeGreaterThan(-1)
        expect(listed.indexOf("notary keys")).toBeLessThan(listed.indexOf("bot allowlist"))
    })

    it("states the bot threshold in both snapshot units", () => {
        const guide = readFileSync(join(import.meta.dir, "../docs/mainnet/genesis.md"), "utf8")
        const rule = guide.split("### Bot authorization: launch decision and gate")[1]?.split("Before publishing")[0]
        expect(rule).toMatch(/1e12 threshold is in the units written in the file:[\s\S]*1000 DEM when\s+the file uses OS/)
        expect(rule).toMatch(/1e12 DEM when the file uses DEM/)
        expect(rule).not.toMatch(/duplicate qualifying entry/i)
        expect(guide).toContain("The launch check changes no node behavior.")
        expect(guide).not.toContain("This patch changes no node behavior or state transition.")
    })

    it("leaves the plan check to the genesis owners in the operator install guide", () => {
        const install = readFileSync(join(import.meta.dir, "../INSTALL.md"), "utf8")
        expect(install).toMatch(
            /The genesis owners run the \[plan check, including the bot allowlist review\]\(docs\/mainnet\/genesis\.md#bot-authorization-launch-decision-and-gate\), on the published file before launch; mount exactly that file at `\/app\/data\/genesis\.json`\./,
        )
        expect(install).not.toMatch(/Before launch, run the \[genesis plan check/)
        expect(install).toContain("Every bot must have a raw genesis allocation of at least `1_000_000_000_000`")
        expect(install).toContain("Preserve that genesis file on upgrades: bot authorization is reloaded from it at every boot.")
    })

    it("reports a missing genesis once across the genesis and bot checks", () => {
        const checks = launchPlanChecks({
            genesis: null, blockZero: null, shardSize: 10, operators: null,
        })
        const details = checks
            .filter(c => c.name === "genesis forks" || c.name === "bot allowlist")
            .flatMap(c => c.details)
        expect(details).toEqual([
            "no genesis file: its fork schedule and block 0's validator set cannot be checked",
        ])
    })

    it("refuses a bot absent from the genesis allocations", () => {
        const check = botCheck([], [a])
        expect(check.ok).toBe(false)
        expect(check.details.join("\n")).toContain(`intended bot is not authorized: ${a}`)
    })

    it("requires an explicit inventory, including an explicit no-bots decision", () => {
        expect(botCheck([]).ok).toBe(false)
        expect(botCheck([]).details.join("\n")).toContain("--bots")
        expect(botCheck([], []).ok).toBe(true)
        expect(botCheck([[a, "1000000000000"]], []).ok).toBe(false)
    })

    it("asks for --bots when no inventory was passed", () => {
        expect(botCheck([]).details).toEqual([
            "pass --bots FILE containing the reviewed JSON array of bot addresses (use [] for no bots)",
        ])
    })

    it("identifies an inventory file that is not a JSON array", () => {
        expect(botCheck([], { bots: [] }).details).toEqual([
            "--bots must contain a JSON array of addresses",
        ])
    })

    it("names each invalid inventory entry, in order", () => {
        const upper = a.toUpperCase()
        const check = botCheck([[a, "1000000000000"]], ["FILL", upper, a, 1])
        expect(check.ok).toBe(false)
        expect(check.details).toEqual([
            "--bots entry \"FILL\" is not a lowercase 0x-prefixed 64-hex address",
            `--bots entry "${upper}" is not a lowercase 0x-prefixed 64-hex address`,
            "--bots entry 1 is not a lowercase 0x-prefixed 64-hex address",
        ])
        expect(check.details[1]).toContain(upper)
    })

    it("uses the raw genesis amount before denomination or snapshot restore", () => {
        expect(botCheck([[a, "999999999999"]], [a]).ok).toBe(false)
        expect(botCheck([[a, "1000000000000"]], [a]).ok).toBe(true)
        expect(botCheck([[a, 1000000000000]], [a]).ok).toBe(true)
    })

    it("requires approval of every qualifying account, including non-bot allocations", () => {
        const check = botCheck([[a, "1000000000000"], [b, "2000000000000"]], [a])
        expect(check.ok).toBe(false)
        expect(check.details.join("\n")).toContain(`unreviewed authorized bot: ${b}`)
    })

    it("validates the inventory and compares addresses exactly as the loader does", () => {
        for (const invalid of [null, {}, "FILL", [a, a], [a.toUpperCase()], ["FILL"], [1]]) {
            expect(botCheck([], invalid).ok).toBe(false)
        }
        expect(botCheck(undefined, []).ok).toBe(false)
        expect(botCheck([null], []).ok).toBe(false)
        expect(botCheck([[a.toUpperCase(), "1000000000000"]], [a]).ok).toBe(false)
    })

    it("matches the startup loader for boundary, invalid and duplicate balances", async () => {
        const balances = [
            [a, "1000000000000"], [a, "0"], [b, "9"], [b, "999999999999"],
            [b, "FILL"], [b, "1.5e12"], [b, null],
        ]
        writeFileSync(file, JSON.stringify({ balances }))
        process.env.DEMOS_GENESIS_FILE = file
        await loadGenesisIdentities()
        expect([...getSharedState.genesisIdentities]).toEqual([a])
        expect(botCheck(balances, [...getSharedState.genesisIdentities]).ok).toBe(true)
        // A duplicate below the threshold does not revoke a qualifying entry.
        expect(botCheck([[a, "0"], [a, "1000000000000"]], [a]).ok).toBe(true)
    })

    it("also refuses the live launch decision when an intended bot is absent", () => {
        const decision = checkLaunch({
            genesis: { balances: [] }, botAllowlist: [a], blockZero: null,
            shardSize: 10, probes: [], operators: null,
        })
        expect(decision.go).toBe(false)
        expect(decision.reasons.join("\n")).toContain(`intended bot is not authorized: ${a}`)
    })

    it("takes the inventory only from the explicit --bots file argument", () => {
        expect(parseArgs(["--bots", "mainnet/bots.json"], {}).bots).toBe("mainnet/bots.json")
        expect(parseArgs([], {}).bots).toBeNull()
        expect(() => parseArgs(["--bots"], {})).toThrow("--bots needs a value")
    })

    it("wires the inventory into the CLI plan and reports missing input as NO-GO", () => {
        writeFileSync(file, JSON.stringify({ properties: { id: 7, shardSize: 10 }, balances: [] }))
        const bots = join(dir, "bots.json")
        const operators = join(dir, "operators.json")
        writeFileSync(bots, JSON.stringify([a]))
        writeFileSync(operators, "{}")
        const args = [process.execPath, "--tsconfig-override", join(import.meta.dir, "../tsconfig.json"),
            join(import.meta.dir, "launch-go-no-go.ts"), "--plan", "--genesis", file,
            "--snapshot", dir, "--operators", operators, "--json"]
        for (const extra of [[], ["--bots", bots]]) {
            const result = Bun.spawnSync([...args, ...extra], { cwd: dir, stdout: "pipe", stderr: "pipe" })
            expect(result.exitCode).toBe(1)
            const out = result.stdout.toString()
            const check = JSON.parse(out.slice(out.indexOf("{"))).checks.find((c: any) => c.name === "bot allowlist")
            expect(check.ok).toBe(false)
            expect(check.details.join("\n")).toContain(extra.length ? `intended bot is not authorized: ${a}` : "--bots")
        }
    }, 30_000)

    it("refuses a JSON-encoded genesis string the node's bot loader cannot read, in --plan and GO", async () => {
        const reason = "genesis file is a JSON-encoded string; the node's bot loader parses it once and fails at boot on it"
        const genesis = { properties: { id: 7, shardSize: 10 }, balances: [[a, "1000000000000"]] }
        const bots = join(dir, "bots-a.json")
        const operators = join(dir, "operators.json")
        writeFileSync(bots, JSON.stringify([a]))
        writeFileSync(operators, "{}")
        const run = (contents: string, plan: boolean) => {
            writeFileSync(file, contents)
            const result = Bun.spawnSync([process.execPath, "--tsconfig-override", join(import.meta.dir, "../tsconfig.json"),
                join(import.meta.dir, "launch-go-no-go.ts"), ...(plan ? ["--plan"] : []), "--genesis", file,
                "--snapshot", dir, "--operators", operators, "--bots", bots, "--json", "--timeout", "2000"],
            { cwd: dir, stdout: "pipe", stderr: "pipe" })
            expect(result.exitCode).toBe(1)
            const out = result.stdout.toString()
            const json = JSON.parse(out.slice(out.indexOf("{")))
            // The bot allowlist check in --plan, the bot reasons in GO
            return plan
                ? json.checks.find((c: any) => c.name === "bot allowlist").details
                : json.reasons.filter((r: string) => /bot loader|--bots|intended bot|authorized bot|bot allowlist/.test(r))
        }
        for (const plan of [true, false]) {
            expect(run(JSON.stringify(JSON.stringify(genesis)), plan)).toEqual([reason])
            expect(run(JSON.stringify(genesis), plan)).toEqual([])
        }

        // The loader the check stands for cannot read the refused file
        writeFileSync(file, JSON.stringify(JSON.stringify(genesis)))
        process.env.DEMOS_GENESIS_FILE = file
        await expect(loadGenesisIdentities()).rejects.toThrow()

        const input = { genesis, botAllowlist: [a], blockZero: null, shardSize: 10, operators: null }
        for (const genesisIsJsonString of [true, false]) {
            const planDetails = launchPlanChecks({ ...input, genesisIsJsonString }).find(c => c.name === "bot allowlist")?.details
            const liveReasons = checkLaunch({ ...input, probes: [], genesisIsJsonString }).reasons
            expect(planDetails).toEqual(genesisIsJsonString ? [reason] : [])
            expect(liveReasons.includes(reason)).toBe(genesisIsJsonString)
        }
    }, 120_000)

    it("reports unreadable or malformed bot inventories without a stack trace", () => {
        writeFileSync(file, JSON.stringify({ properties: { id: 7, shardSize: 10 }, balances: [] }))
        const bots = join(dir, "invalid-bots.json")
        const operators = join(dir, "operators.json")
        writeFileSync(bots, "{")
        writeFileSync(operators, "{}")
        const args = [process.execPath, "--tsconfig-override", join(import.meta.dir, "../tsconfig.json"),
            join(import.meta.dir, "launch-go-no-go.ts"), "--plan", "--genesis", file,
            "--snapshot", dir, "--operators", operators]
        for (const badFile of [bots, join(dir, "missing-bots.json")]) {
            const result = Bun.spawnSync([...args, "--bots", badFile], { cwd: dir, stdout: "pipe", stderr: "pipe" })
            expect(result.exitCode).toBe(2)
            const stderr = result.stderr.toString().trim()
            expect(stderr).toMatch(/(?:^|\n)--bots: [^\n]+$/)
            expect(stderr).not.toContain("at main (")
        }
    }, 30_000)
})
