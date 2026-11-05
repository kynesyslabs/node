import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// `--env-from env` keeps docker out of it: the doctor reads the process
// environment we pass, over a .env this checkout may hold.
const repo = path.resolve(import.meta.dir, "..")
const doctor = path.join(repo, "scripts/node-doctor")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "node-doctor-"))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// The doctor's own list, so optional sheet lines (the genesis pins, once
// filled in) are not mistaken for required ones.
function requiredKeys(): string[] {
    const script = fs.readFileSync(path.join(repo, "scripts/node-doctor"), "utf8")
    const m = /^SHEET_REQUIRED_KEYS=\(([^)]*)\)/m.exec(script)
    if (!m) throw new Error("SHEET_REQUIRED_KEYS not found in scripts/node-doctor")
    return m[1].split(/\s+/).filter(Boolean)
}

function readSheet(file: string): Record<string, string> {
    const values: Record<string, string> = {}
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
        if (m) values[m[1]] = m[2].trim()
    }
    return values
}

function run(env: Record<string, string>, ...args: string[]) {
    const r = spawnSync(
        "bash",
        [doctor, "--production", "--env-from", "env", ...args],
        {
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "", HOME: tmp, ...env },
            timeout: 60_000,
        },
    )
    return { status: r.status, lines: r.stdout.split("\n") }
}

function writeSheet(name: string, body: string): string {
    const file = path.join(tmp, name)
    fs.writeFileSync(file, body)
    return file
}

const line = (lines: string[], key: string) =>
    lines.find(l => l.startsWith(`PASS ${key}:`) || l.startsWith(`FAIL ${key}:`))

describe("node-doctor --production against the parameter sheet", () => {
    it("passes every published value when the node runs exactly the sheet", () => {
        const sheet = readSheet(path.join(repo, "docs/mainnet/parameters.env"))
        expect(Object.keys(sheet).length).toBeGreaterThan(0)
        const { lines } = run(sheet)
        for (const key of Object.keys(sheet)) {
            expect([key, line(lines, key)?.slice(0, 4)]).toEqual([key, "PASS"])
        }
    }, 60_000)

    it("fails a value that differs from the sheet and one that is not set", () => {
        const sheet = writeSheet(
            "differs.env",
            "# comment\nDOCTOR_TEST_FEE=1\nDOCTOR_TEST_UNSET_KEY=5\n",
        )
        const { status, lines } = run({ DOCTOR_TEST_FEE: "2" }, "--parameters", sheet)
        expect(status).toBe(1)
        expect(line(lines, "DOCTOR_TEST_FEE")).toStartWith("FAIL DOCTOR_TEST_FEE: is '2', the sheet says 1")
        expect(line(lines, "DOCTOR_TEST_UNSET_KEY")).toStartWith("FAIL DOCTOR_TEST_UNSET_KEY: not set")
    }, 60_000)

    it("does not take a spelling the node also accepts for the sheet's value", () => {
        const sheet = writeSheet("prod.env", "PROD=true\n")
        const { lines } = run({ PROD: "1" }, "--parameters", sheet)
        expect(line(lines, "PROD")).toStartWith("FAIL PROD: is '1'")
    }, 60_000)

    it("compares a published genesis pin, case and 0x aside", () => {
        const pin = "ab".repeat(32)
        const sheet = writeSheet("pin.env", `EXPECTED_GENESIS_HASH=0x${pin}\n`)
        const same = run({ EXPECTED_GENESIS_HASH: pin.toUpperCase() }, "--parameters", sheet)
        expect(line(same.lines, "EXPECTED_GENESIS_HASH")).toBe("PASS EXPECTED_GENESIS_HASH: set")
        const other = run({ EXPECTED_GENESIS_HASH: "cd".repeat(32) }, "--parameters", sheet)
        expect(line(other.lines, "EXPECTED_GENESIS_HASH")).toStartWith("FAIL EXPECTED_GENESIS_HASH: is cd")
    }, 60_000)

    it("fails a sheet line it cannot read and a key the sheet repeats", () => {
        const published = fs.readFileSync(path.join(repo, "docs/mainnet/parameters.env"), "utf8")
        const sheet = writeSheet(
            "malformed.env",
            published.replace(/^PROD=true$/m, "PROD =true") + "NETWORK_FEE=2\n",
        )
        const { status, lines } = run(readSheet(path.join(repo, "docs/mainnet/parameters.env")), "--parameters", sheet)
        expect(status).toBe(1)
        expect(lines).toContain(`FAIL parameter sheet: ${sheet} line ${published.split("\n").findIndex(l => l === "PROD=true") + 1} is not KEY=value: PROD =true`)
        expect(lines.some(l => l.startsWith("FAIL parameter sheet:") && l.endsWith("sets NETWORK_FEE again"))).toBe(true)
        expect(lines).toContain(`FAIL parameter sheet: ${sheet} has no PROD= line`)
    }, 60_000)

    it("requires every published key and nothing beyond them", () => {
        const published = readSheet(path.join(repo, "docs/mainnet/parameters.env"))
        const required = requiredKeys()
        expect(required.filter(k => !(k in published))).toEqual([])
        const full = run(published)
        expect(full.lines.filter(l => l.startsWith("FAIL parameter sheet:"))).toEqual([])
        const partial = run({ PROD: "true" }, "--parameters", writeSheet("partial.env", "PROD=true\n"))
        expect(partial.status).toBe(1)
        for (const key of required.filter(k => k !== "PROD")) {
            expect(partial.lines).toContain(`FAIL parameter sheet: ${path.join(tmp, "partial.env")} has no ${key}= line`)
        }
    }, 60_000)

    it("accepts the genesis pins once they are filled in", () => {
        const text = fs.readFileSync(path.join(repo, "docs/mainnet/parameters.env"), "utf8")
        const pinned = text.replace(/^# (EXPECTED_GENESIS(?:_BLOCK)?_HASH)=$/gm, "$1=0xabc")
        expect(pinned).not.toBe(text)
        const sheet = writeSheet("pinned.env", pinned)
        const { lines } = run(readSheet(sheet), "--parameters", sheet)
        expect(lines.filter(l => l.startsWith("FAIL parameter sheet:"))).toEqual([])
    }, 60_000)

    it("fails a sheet line with no value", () => {
        const text = fs.readFileSync(path.join(repo, "docs/mainnet/parameters.env"), "utf8")
        const sheet = writeSheet("empty.env", text.replace(/^PROD=true$/m, "PROD="))
        const n = text.split("\n").findIndex(l => l === "PROD=true") + 1
        const { status, lines } = run(readSheet(path.join(repo, "docs/mainnet/parameters.env")), "--parameters", sheet)
        expect(status).toBe(1)
        expect(lines).toContain(`FAIL parameter sheet: ${sheet} line ${n} gives PROD no value`)
    }, 60_000)

    it("fails when the sheet is missing", () => {
        const { status, lines } = run({}, "--parameters", path.join(tmp, "nope.env"))
        expect(status).toBe(1)
        expect(lines.some(l => l.startsWith("FAIL parameter sheet:"))).toBe(true)
    }, 60_000)
})
