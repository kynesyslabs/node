import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { SHARD_SIZE_MAX, SHARD_SIZE_MIN } from "src/libs/consensus/genesisShardSize"
import { quorumThreshold } from "src/libs/consensus/v2/quorum"
import { DEFAULT_FORK_CONFIG } from "src/forks/forkConfig"
import { genesisScheduleProblems } from "src/libs/blockchain/genesis/genesisPin"

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

// With a GITHUB_TOKEN set the doctor asks GitHub about it. A curl that
// answers 200 first on PATH keeps these runs off the network.
const offline = path.join(tmp, "offline")
fs.mkdirSync(offline)
fs.writeFileSync(path.join(offline, "curl"), "#!/bin/sh\ncat >/dev/null\nprintf '\\n200'\n")
fs.chmodSync(path.join(offline, "curl"), 0o755)

function run(env: Record<string, string>, ...args: string[]) {
    const r = spawnSync(
        "bash",
        [doctor, "--production", "--env-from", "env", ...args],
        {
            encoding: "utf8",
            env: { PATH: `${offline}:${process.env.PATH ?? ""}`, HOME: tmp, ...env },
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

describe("node-doctor --production web2 identity credentials", () => {
    const credentials = {
        GITHUB_TOKEN: "ghp_test",
        DISCORD_BOT_TOKEN: "discord-test",
        RAPID_API_KEY: "rapid-key",
        RAPID_API_HOST: "twitter-api.example.com",
    }

    it("passes when every provider credential is set, without printing it", () => {
        const { lines } = run(credentials)
        for (const key of Object.keys(credentials)) {
            expect(line(lines, key)).toBe(`PASS ${key}: set`)
        }
        expect(lines.some(l => l.includes("ghp_test"))).toBe(false)
    }, 60_000)

    it("asks the test's curl about the token, not GitHub", () => {
        const { lines } = run(credentials)
        expect(lines).toContain("PASS GitHub token: accepted by GitHub")
    }, 60_000)

    it("fails missing provider credentials while accepting the default RapidAPI host", () => {
        const { status, lines } = run({
            GITHUB_TOKEN: "",
            DISCORD_BOT_TOKEN: "  ",
            RAPID_API_KEY: "rapid-key",
        })
        expect(status).toBe(1)
        expect(line(lines, "GITHUB_TOKEN")).toStartWith("FAIL GITHUB_TOKEN: empty: this node would refuse every GitHub identity link")
        expect(line(lines, "DISCORD_BOT_TOKEN")).toStartWith("FAIL DISCORD_BOT_TOKEN: empty: this node would refuse every Discord identity link")
        expect(line(lines, "RAPID_API_KEY")).toBe("PASS RAPID_API_KEY: set")
        expect(line(lines, "RAPID_API_HOST")).toBe("PASS RAPID_API_HOST: empty: using Twitter API45 default (twitter-api45.p.rapidapi.com)")
    }, 60_000)

    it("uses the default for an explicitly empty RapidAPI host while requiring its key", () => {
        const { lines } = run({ ...credentials, RAPID_API_HOST: "", RAPID_API_KEY: "" })
        expect(line(lines, "RAPID_API_HOST")).toBe("PASS RAPID_API_HOST: empty: using Twitter API45 default (twitter-api45.p.rapidapi.com)")
        expect(line(lines, "RAPID_API_KEY")).toStartWith("FAIL RAPID_API_KEY: empty:")
    }, 60_000)

    it("fails a whitespace-only RapidAPI host", () => {
        const { status, lines } = run({ ...credentials, RAPID_API_HOST: " \t " })
        expect(status).toBe(1)
        expect(line(lines, "RAPID_API_HOST")).toBe("FAIL RAPID_API_HOST: RAPID_API_HOST is whitespace only; the node will not fall back to the default for it")
    }, 60_000)
})

const BASH = Bun.which("bash") as string
const GREP = Bun.which("grep") as string

let bin: string

/** Puts a fake command on the PATH the check sees, printing `output`. */
function fakeCommand(name: string, output: string): void {
    const file = path.join(bin, name)
    fs.writeFileSync(file, `#!${BASH}\nprintf '%s\\n' ${JSON.stringify(output)}\n`)
    fs.chmodSync(file, 0o755)
}

/** Runs one production check with only the fake commands (and grep) on PATH. */
function runCheck(check: string): { line: string; fails: number; warns: number } {
    const run = Bun.spawnSync(
        [BASH, "-c", `source "${doctor}"; ${check}; echo "fails=$PROD_FAILS warns=$PROD_WARNS"`],
        { env: { PATH: bin } },
    )
    const lines = run.stdout.toString().trim().split("\n")
    const counts = /fails=(\d+) warns=(\d+)/.exec(lines.at(-1) ?? "")
    return {
        line: lines[0],
        fails: Number(counts?.[1]),
        warns: Number(counts?.[2]),
    }
}

describe("node-doctor checks against fake commands", () => {
    beforeEach(() => {
        bin = fs.mkdtempSync(path.join(os.tmpdir(), "node-doctor-"))
        fs.symlinkSync(GREP, path.join(bin, "grep"))
    })

    afterEach(() => {
        fs.rmSync(bin, { recursive: true, force: true })
    })

    describe("node-doctor --production clock sync", () => {
        it("passes when timedatectl reports NTPSynchronized=yes", () => {
            fakeCommand("timedatectl", "yes")
            expect(runCheck("check_clock_sync")).toEqual({
                line: "PASS clock sync: timedatectl NTPSynchronized=yes",
                fails: 0,
                warns: 0,
            })
        })

        it("fails when timedatectl reports the clock is not synchronised", () => {
            fakeCommand("timedatectl", "no")
            const result = runCheck("check_clock_sync")
            expect(result.line).toStartWith("FAIL clock sync:")
            expect(result.line).toContain("NTPSynchronized=no")
            expect(result.fails).toBe(1)
        })

        it("passes on chrony when timedatectl says no", () => {
            fakeCommand("timedatectl", "no")
            fakeCommand("chronyc", "Leap status     : Normal")
            expect(runCheck("check_clock_sync").line).toBe(
                "PASS clock sync: chronyc tracking: Leap status Normal",
            )
        })

        it("fails when chrony is installed but not synchronised", () => {
            fakeCommand("chronyc", "Leap status     : Not synchronised")
            expect(runCheck("check_clock_sync").fails).toBe(1)
        })

        it("skips with a warning when neither timedatectl nor chronyc exists", () => {
            const result = runCheck("check_clock_sync")
            expect(result.line).toStartWith("WARN clock sync: skipped")
            expect(result).toMatchObject({ fails: 0, warns: 1 })
        })
    })

    describe("node-doctor --production env files", () => {
        it("passes a checkout with only .env", () => {
            fs.writeFileSync(path.join(bin, ".env"), "PROD=true\n")
            expect(runCheck(`cd "${bin}"; check_extra_env_files`)).toEqual({
                line: "PASS env files: only .env",
                fails: 0,
                warns: 0,
            })
        })

        it("fails when bun would load another env file over .env", () => {
            fs.writeFileSync(path.join(bin, ".env.local"), "NETWORK_FEE=2\n")
            fs.writeFileSync(path.join(bin, ".env.production"), "PROD=false\n")
            const result = runCheck(`cd "${bin}"; check_extra_env_files`)
            expect(result.line).toStartWith("FAIL env files: .env.local .env.production present")
            expect(result.fails).toBe(1)
        })
    })

    describe("node-doctor --production GitHub token", () => {
        const TOKEN_REJECTED =
            "this node's GitHub token was rejected by GitHub (expired or revoked); the node operator must renew GITHUB_TOKEN"

        /** A curl that keeps its arguments and stdin, prints `stdout`, `stderr` and exits with `code`. */
        function fakeCurl(stdout: string, stderr = "", code = 0): void {
            const file = path.join(bin, "curl")
            fs.writeFileSync(
                file,
                `#!${BASH}\nprintf '%s\\n' "$@" > "${bin}/curl.args"\n` +
                    `while IFS= read -r l; do printf '%s\\n' "$l"; done > "${bin}/curl.stdin"\n` +
                    `printf ${JSON.stringify(stderr)} >&2\nprintf ${JSON.stringify(stdout)}\nexit ${code}\n`,
            )
            fs.chmodSync(file, 0o755)
        }
        const curlFile = (name: string) => fs.readFileSync(path.join(bin, `curl.${name}`), "utf8")
        const check = (token = "ghp_secret") =>
            runCheck(`NODE_ENV_VALUES[GITHUB_TOKEN]=${JSON.stringify(token)}; check_github_token`)

        it("passes when GitHub accepts the token, asking once with a bounded wait", () => {
            fakeCurl("\\n200")
            expect(check()).toEqual({ line: "PASS GitHub token: accepted by GitHub", fails: 0, warns: 0 })
            const args = curlFile("args").split("\n")
            expect(args).toContain("https://api.github.com/rate_limit")
            expect(args[args.indexOf("--max-time") + 1]).toBe("10")
        })

        it("sends the token on stdin, never on the command line", () => {
            fakeCurl("\\n200")
            check()
            expect(curlFile("args")).not.toContain("ghp_secret")
            expect(curlFile("stdin")).toBe('header = "Authorization: Bearer ghp_secret"\n')
        })

        // Octokit's createTokenAuth strips /^(token|bearer) +/i before it sends the token.
        it.each(["token ghp_secret", "Bearer ghp_secret", "BEARER   ghp_secret"])(
            "drops the scheme from '%s', as the node's GitHub client does",
            token => {
                fakeCurl("\\n200")
                expect(check(token)).toEqual({ line: "PASS GitHub token: accepted by GitHub", fails: 0, warns: 0 })
                expect(curlFile("stdin")).toBe('header = "Authorization: Bearer ghp_secret"\n')
            },
        )

        it("keeps a token that only starts with those letters", () => {
            fakeCurl("\\n200")
            check("tokenghp_secret")
            expect(curlFile("stdin")).toBe('header = "Authorization: Bearer tokenghp_secret"\n')
        })

        it("fails with the cause when GitHub rejects the token", () => {
            fakeCurl("\\n401")
            const result = check()
            expect(result.line).toBe(`FAIL GitHub token: ${TOKEN_REJECTED}`)
            expect(result.fails).toBe(1)
        })

        it("warns when GitHub cannot be reached", () => {
            fakeCurl("\\n000", "curl: (6) Could not resolve host: api.github.com\\n", 6)
            const result = check()
            expect(result.line).toBe(
                "WARN GitHub token: api.github.com could not be reached (curl: (6) Could not resolve host: api.github.com): the node reads gists there, so allow outbound HTTPS to it",
            )
            expect(result).toMatchObject({ fails: 0, warns: 1 })
        })

        it("warns on any other answer", () => {
            fakeCurl("\\n403")
            const result = check()
            expect(result.line).toStartWith("WARN GitHub token: api.github.com answered HTTP 403")
            expect(result).toMatchObject({ fails: 0, warns: 1 })
        })

        it("skips with a warning when curl is not installed", () => {
            const result = check()
            expect(result.line).toStartWith("WARN GitHub token: skipped: curl is needed")
            expect(result).toMatchObject({ fails: 0, warns: 1 })
        })

        it("leaves an empty token to the credentials check, without asking GitHub", () => {
            fakeCurl("\\n401")
            expect(check("  ")).toEqual({ line: "fails=0 warns=0", fails: 0, warns: 0 })
            expect(fs.existsSync(path.join(bin, "curl.args"))).toBe(false)
        })

        it("says in --help that --production sends the token to api.github.com", () => {
            const help = Bun.spawnSync([BASH, doctor, "--help"], { env: { PATH: process.env.PATH ?? "" } })
            expect(help.exitCode).toBe(0)
            expect(help.stdout.toString()).toContain("the GitHub token (one request to api.github.com)")
        })
    })

    describe("node-doctor sourcing", () => {
        it("defines the checks without running the doctor", () => {
            const run = Bun.spawnSync([BASH, "-c", `source "${doctor}"; type -t check_clock_sync`], {
                env: { PATH: bin },
            })
            expect(run.stdout.toString().trim()).toBe("function")
        })
    })
})

const PYTHON3 = Bun.which("python3") as string

describe("node-doctor --production genesis file", () => {
    let dir: string
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-doctor-genesis-"))
        fs.symlinkSync(PYTHON3, path.join(dir, "python3"))
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    const validator = (i: number, url: unknown = `http://10.0.0.${i}:53550`) => ({
        address: "0x" + i.toString(16).padStart(64, "0"),
        status: "2",
        connection_url: url,
        staked_amount: "1000000000000",
        first_seen: 0,
        valid_at: 0,
    })
    const many = (n: number) => Array.from({ length: n }, (_, i) => validator(i + 1))

    function writeGenesis(shardSize: unknown, validators: unknown[]): string {
        const file = path.join(dir, "genesis.json")
        fs.writeFileSync(file, JSON.stringify({ properties: { id: 4242, shardSize }, validators }))
        return file
    }

    /** Runs check_genesis_file alone, with the node settings and compose config given. */
    function check(settings: Record<string, string>, composeJson = ""): { lines: string[]; fails: number } {
        const assign = Object.entries(settings)
            .map(([k, v]) => `NODE_ENV_VALUES[${k}]=${JSON.stringify(v)}`)
            .join("; ") || ":"
        const run = Bun.spawnSync(
            [BASH, "-c", `source "${doctor}"; ${assign}; COMPOSE_CONFIG_JSON="$DOCTOR_COMPOSE"; check_genesis_file; echo "fails=$PROD_FAILS"`],
            { env: { PATH: dir, DOCTOR_COMPOSE: composeJson } },
        )
        const lines = run.stdout.toString().trim().split("\n")
        return { lines: lines.slice(0, -1), fails: Number(/fails=(\d+)/.exec(lines.at(-1) ?? "")?.[1]) }
    }
    const lineOf = (lines: string[], item: string) => lines.find(l => / /.test(l) && l.slice(5).startsWith(`${item}:`))

    it("mirrors the node's shardSize range", () => {
        const script = fs.readFileSync(doctor, "utf8")
        expect(Number(/^GENESIS_SHARD_SIZE_MIN=(\d+)$/m.exec(script)?.[1])).toBe(SHARD_SIZE_MIN)
        expect(Number(/^GENESIS_SHARD_SIZE_MAX=(\d+)$/m.exec(script)?.[1])).toBe(SHARD_SIZE_MAX)
    })

    it("passes a genesis the node accepts and can forge on", () => {
        const file = writeGenesis(10, many(7))
        const { lines, fails } = check({ DEMOS_GENESIS_FILE: file, DEMOS_SNAPSHOT_DIR: dir })
        expect(lines).toEqual([
            `PASS genesis file: ${file}`,
            "PASS genesis shardSize: 10",
            "PASS genesis validators: 7 in the genesis validators, quorum 7",
            "PASS genesis connection_url: 7 validators in the genesis validators",
        ])
        expect(fails).toBe(0)
    })

    it("fails a shardSize outside the range the node accepts", () => {
        for (const bad of [SHARD_SIZE_MIN - 1, SHARD_SIZE_MAX + 1, 1, "10", null]) {
            const { lines, fails } = check({ DEMOS_GENESIS_FILE: writeGenesis(bad, many(10)), DEMOS_SNAPSHOT_DIR: dir })
            expect([bad, lineOf(lines, "genesis shardSize")?.slice(0, 4)]).toEqual([bad, "FAIL"])
            expect(fails).toBe(1)
        }
        const { lines } = check({ DEMOS_GENESIS_FILE: writeGenesis(1, many(1)), DEMOS_SNAPSHOT_DIR: dir })
        expect(lineOf(lines, "genesis shardSize")).toBe(
            `FAIL genesis shardSize: properties.shardSize is 1, outside the [${SHARD_SIZE_MIN}, ${SHARD_SIZE_MAX}] the node accepts: it refuses this genesis at boot`,
        )
    })

    it("fails fewer validators than the node's quorum of shardSize", () => {
        for (const shardSize of [SHARD_SIZE_MIN, 4, 10, SHARD_SIZE_MAX]) {
            const quorum = quorumThreshold(shardSize)
            const short = check({ DEMOS_GENESIS_FILE: writeGenesis(shardSize, many(quorum - 1)), DEMOS_SNAPSHOT_DIR: dir })
            expect(lineOf(short.lines, "genesis validators")).toBe(
                `FAIL genesis validators: ${quorum - 1} in the genesis validators, below the quorum of ${quorum} ` +
                    `(2/3 + 1 of shardSize ${shardSize}): the node boots but no block after block 0 can be forged`,
            )
            const enough = check({ DEMOS_GENESIS_FILE: writeGenesis(shardSize, many(quorum)), DEMOS_SNAPSHOT_DIR: dir })
            expect(enough.fails).toBe(0)
        }
    })

    function writeSnapshotValidators(rows: unknown[]) {
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ files: { "validators.jsonl": { rows: rows.length } } }))
        fs.writeFileSync(path.join(dir, "validators.jsonl"), rows.map(r => JSON.stringify(r)).join("\n") + "\n")
    }

    it("counts the snapshot's validators.jsonl when the snapshot carries one", () => {
        const file = writeGenesis(10, many(1))
        writeSnapshotValidators(many(7))
        const { lines, fails } = check({ DEMOS_GENESIS_FILE: file, DEMOS_SNAPSHOT_DIR: dir })
        expect(lineOf(lines, "genesis validators")).toBe("PASS genesis validators: 7 in the snapshot's validators.jsonl, quorum 7")
        expect(lineOf(lines, "genesis connection_url")).toBe(
            "PASS genesis connection_url: 7 validators in the snapshot's validators.jsonl",
        )
        expect(fails).toBe(0)

        fs.writeFileSync(path.join(dir, "validators.jsonl"), "{ not json\n")
        const broken = check({ DEMOS_GENESIS_FILE: file, DEMOS_SNAPSHOT_DIR: dir })
        expect(lineOf(broken.lines, "genesis validators")).toStartWith(
            "FAIL genesis validators: the snapshot's validators.jsonl cannot be read",
        )
    })

    it("counts only the validators active at block 0, as the committee of block 1 is drawn", () => {
        const rows: Record<string, unknown>[] = many(7)
        rows[4] = { ...rows[4], valid_at: null }
        rows[5] = { ...rows[5], valid_at: 1 }
        rows[6] = { ...rows[6], status: "1" }
        const expected =
            '4 in %s (of 7 listed; only status "2" with valid_at 0 vote from block 1), below the quorum of 7 ' +
            "(2/3 + 1 of shardSize 10): the node boots but no block after block 0 can be forged"
        const fromGenesis = check({ DEMOS_GENESIS_FILE: writeGenesis(10, rows), DEMOS_SNAPSHOT_DIR: dir })
        expect(lineOf(fromGenesis.lines, "genesis validators")).toBe(
            "FAIL genesis validators: " + expected.replace("%s", "the genesis validators"),
        )
        writeSnapshotValidators(rows)
        const fromSnapshot = check({ DEMOS_GENESIS_FILE: writeGenesis(10, many(7)), DEMOS_SNAPSHOT_DIR: dir })
        expect(lineOf(fromSnapshot.lines, "genesis validators")).toBe(
            "FAIL genesis validators: " + expected.replace("%s", "the snapshot's validators.jsonl"),
        )
    })

    it("reads valid_at 0.0 as the node does, as the integer 0", () => {
        // JSON.stringify writes 0, so the file is written by hand: the node parses 0.0 to 0
        const lines = many(7).map(v => JSON.stringify(v).replace('"valid_at":0', '"valid_at":0.0'))
        lines[6] = lines[6].replace('"valid_at":0.0', '"valid_at":1.0')
        expect(lines[0]).toContain('"valid_at":0.0')
        const file = path.join(dir, "genesis.json")
        fs.writeFileSync(file, `{"properties":{"id":4242,"shardSize":7},"validators":[${lines.join(",")}]}`)
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")).validators
        expect(parsed.filter((v: { valid_at: number }) => Number.isInteger(v.valid_at) && v.valid_at <= 0)).toHaveLength(6)
        const { lines: out, fails } = check({ DEMOS_GENESIS_FILE: file, DEMOS_SNAPSHOT_DIR: dir })
        expect(lineOf(out, "genesis validators")).toBe(
            'PASS genesis validators: 6 in the genesis validators (of 7 listed; only status "2" with valid_at 0 vote from block 1), quorum 5',
        )
        expect(fails).toBe(0)
    })

    it("checks the URLs of the snapshot's validators when the snapshot owns the set", () => {
        const rows: Record<string, unknown>[] = many(7)
        rows[2] = validator(3, "http://45.13.233.189:65550")
        rows[3] = validator(4, "")
        rows[4] = validator(5, null)
        const { connection_url: _, ...noUrl } = validator(6)
        rows[5] = noUrl
        writeSnapshotValidators(rows)
        const { lines, fails } = check({ DEMOS_GENESIS_FILE: writeGenesis(10, []), DEMOS_SNAPSHOT_DIR: dir })
        expect(lines.filter(l => l.startsWith("FAIL genesis connection_url:"))).toEqual([
            `FAIL genesis connection_url: validators.jsonl row 3 (${validator(3).address}) "http://45.13.233.189:65550" port 65550 is outside 1-65535`,
        ])
        expect(fails).toBe(1)
    })

    it("fails a validator URL no peer can dial", () => {
        const validators = many(7)
        validators[2] = validator(3, "http://45.13.233.189:65550")
        validators[4] = validator(5, "not a url")
        const { lines, fails } = check({ DEMOS_GENESIS_FILE: writeGenesis(10, validators), DEMOS_SNAPSHOT_DIR: dir })
        expect(lines.filter(l => l.startsWith("FAIL genesis connection_url:"))).toEqual([
            `FAIL genesis connection_url: validators[2] (${validator(3).address}) "http://45.13.233.189:65550" port 65550 is outside 1-65535`,
            `FAIL genesis connection_url: validators[4] (${validator(5).address}) "not a url" is not a valid URL`,
        ])
        expect(fails).toBe(2)
        const ok = many(7)
        ok[0] = validator(1, null)
        ok[1] = validator(2, "https://node2.demos.sh")
        ok[2] = validator(3, "http://[::1]:65535/")
        expect(check({ DEMOS_GENESIS_FILE: writeGenesis(10, ok), DEMOS_SNAPSHOT_DIR: dir }).fails).toBe(0)
    })

    it("fails a bare-metal node without DEMOS_GENESIS_FILE", () => {
        const { lines, fails } = check({})
        expect(lines[0]).toStartWith("FAIL genesis file: DEMOS_GENESIS_FILE is not set")
        expect(fails).toBe(1)
    })

    it("reads the file the node container mounts, and fails when nothing is mounted there", () => {
        const file = writeGenesis(1, many(1))
        const compose = (volumes: unknown[], env: Record<string, string> = {}) =>
            JSON.stringify({ services: { node: { volumes, environment: env } } })
        const dataVolume = { type: "volume", source: "node_data", target: "/app/data" }
        const mounted = check({}, compose([dataVolume, { type: "bind", source: file, target: "/app/data/genesis.json" }]))
        expect(mounted.lines[0]).toBe(`PASS genesis file: ${file}`)
        expect(lineOf(mounted.lines, "genesis shardSize")).toStartWith("FAIL genesis shardSize: properties.shardSize is 1")

        // DEMOS_GENESIS_FILE names the path inside the container
        const elsewhere = check(
            { DEMOS_GENESIS_FILE: "/app/mainnet/genesis.json" },
            compose([dataVolume, { type: "bind", source: dir, target: "/app/mainnet" }]),
        )
        expect(elsewhere.lines[0]).toBe(`PASS genesis file: ${dir}/genesis.json`)

        const bundled = check({}, compose([dataVolume]))
        expect(bundled.lines).toEqual([
            "FAIL genesis file: /app/data/genesis.json in the node container is not mounted from the host, so the node " +
                "reads the genesis bundled in the image (the testnet's): mount the published file read-only " +
                "(INSTALL.md, \"Pin the network's genesis\")",
        ])
        expect(bundled.fails).toBe(1)

        // Docker makes a directory where a bind-mounted file did not exist
        const missing = path.join(dir, "absent")
        fs.mkdirSync(missing)
        const created = check({}, compose([dataVolume, { type: "bind", source: missing, target: "/app/data/genesis.json" }]))
        expect(created.lines[0]).toStartWith(`FAIL genesis file: ${missing} is a directory`)
    })
})


describe("node-doctor identity file mode", () => {
    let dir: string
    let tools: string
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-doctor-key-"))
        tools = path.join(dir, "bin")
        fs.mkdirSync(tools)
        for (const name of ["stat", "wc", "grep"]) {
            fs.symlinkSync(Bun.which(name) as string, path.join(tools, name))
        }
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    const keyWithMode = (mode: number): string => {
        const file = path.join(dir, ".demos_identity")
        fs.writeFileSync(file, "0x" + "ab".repeat(64))
        fs.chmodSync(file, mode)
        return file
    }

    const sourced = (script: string, env: Record<string, string> = {}) =>
        Bun.spawnSync([BASH, "-c", `source "${doctor}"; ${script}`], {
            env: { PATH: tools, ...env },
        }).stdout.toString().trim().split("\n")

    const production = (file: string) => {
        const lines = sourced(
            `NODE_ENV_VALUES[IDENTITY_FILE]="${file}"; check_identity_file_mode; echo "fails=$PROD_FAILS warns=$PROD_WARNS"`,
        )
        return { line: lines[0], counts: lines.at(-1) }
    }

    it("--production passes 600 and stricter", () => {
        for (const mode of [0o600, 0o400]) {
            const file = keyWithMode(mode)
            const out = production(file)
            expect(out.line).toBe(`PASS identity file mode: ${file} ${mode.toString(8)}`)
            expect(out.counts).toBe("fails=0 warns=0")
        }
    })

    it("--production fails a key file group or other users can read", () => {
        for (const mode of [0o640, 0o604, 0o644, 0o660]) {
            const file = keyWithMode(mode)
            const out = production(file)
            expect(out.line).toStartWith(`FAIL identity file mode: ${file} has mode ${mode.toString(8)}`)
            expect(out.line).toContain(`chmod 600 ${file}`)
            expect(out.counts).toBe("fails=1 warns=0")
        }
    })

    it("--production warns when the file is not on this host path", () => {
        const out = production(path.join(dir, "missing"))
        expect(out.line).toStartWith("WARN identity file mode:")
        expect(out.counts).toBe("fails=0 warns=1")
    })

    it("the general identity check reports an open mode as a problem", () => {
        const file = keyWithMode(0o644)
        const lines = sourced(
            `check_identity_file; echo "failed=$CHECKS_FAILED"; printf '%s\\n' "\${PROBLEM_MESSAGES[@]}"`,
            { IDENTITY_FILE: file },
        )
        expect(lines[0]).toBe("failed=1")
        expect(lines[1]).toContain("has mode 644")

        fs.chmodSync(file, 0o600)
        expect(sourced(`check_identity_file; echo "failed=$CHECKS_FAILED"`, { IDENTITY_FILE: file })[0]).toBe(
            "failed=0",
        )
    })
})

describe("node-doctor --production genesis fork schedule", () => {
    let dir: string
    let tools: string
    const BUN = process.execPath
    // Pins of the right shape, derived so no key-looking literal is committed
    const PIN = createHash("sha256").update("node-doctor schedule pin").digest("hex")

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-doctor-schedule-"))
        tools = path.join(dir, "bin")
        fs.mkdirSync(tools)
        for (const name of ["env", "grep", "tail"]) {
            fs.symlinkSync(Bun.which(name) as string, path.join(tools, name))
        }
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    /** A mainnet chain id genesis declaring every fork this build knows, minus `leave`. */
    function writeGenesis(leave: string[] = []): string {
        const forks: Record<string, unknown> = {}
        for (const name of Object.keys(DEFAULT_FORK_CONFIG)) {
            if (!leave.includes(name)) forks[name] = { activationHeight: null }
        }
        const file = path.join(dir, "genesis.json")
        fs.writeFileSync(file, JSON.stringify({ properties: { id: 4242, shardSize: 10 }, forks }))
        return file
    }

    function check(settings: Record<string, string>, composeJson = "", env: Record<string, string> = {}) {
        const assign = Object.entries(settings)
            .map(([k, v]) => `NODE_ENV_VALUES[${k}]=${JSON.stringify(v)}`)
            .join("; ") || ":"
        const run = Bun.spawnSync(
            [BASH, "-c", `source "${doctor}"; ${assign}; COMPOSE_CONFIG_JSON="$DOCTOR_COMPOSE"; check_genesis_schedule; echo "fails=$PROD_FAILS warns=$PROD_WARNS"`],
            { cwd: repo, env: { PATH: tools, DOCTOR_COMPOSE: composeJson, ...env } },
        )
        const lines = run.stdout.toString().trim().split("\n")
        return { lines: lines.slice(0, -1), counts: lines.at(-1) }
    }

    const withBun = () => fs.symlinkSync(BUN, path.join(tools, "bun"))

    it("fails a genesis the node refuses at boot, with the node's own reason", () => {
        withBun()
        const file = writeGenesis(["l2psSettlement", "tlsnVerified"])
        const [reason] = genesisScheduleProblems({
            fileGenesisData: JSON.parse(fs.readFileSync(file, "utf8")),
            pin: PIN,
            blockPin: PIN,
        })
        expect(reason).toStartWith("the genesis does not declare l2psSettlement, tlsnVerified")
        const out = check({ DEMOS_GENESIS_FILE: file, EXPECTED_GENESIS_HASH: PIN, EXPECTED_GENESIS_BLOCK_HASH: PIN })
        expect(out.lines).toEqual([`FAIL genesis fork schedule: the node refuses to boot on it: ${reason}`])
        expect(out.counts).toBe("fails=1 warns=0")
    }, 30_000)

    it("passes a genesis the node's boot check accepts", () => {
        withBun()
        const out = check({ DEMOS_GENESIS_FILE: writeGenesis(), EXPECTED_GENESIS_HASH: PIN, EXPECTED_GENESIS_BLOCK_HASH: PIN })
        expect(out.lines).toEqual(["PASS genesis fork schedule: the node's boot check accepts it"])
        expect(out.counts).toBe("fails=0 warns=0")
    }, 30_000)

    it("warns that the check was skipped on a bare-metal host without bun", () => {
        const out = check({ DEMOS_GENESIS_FILE: writeGenesis(["tlsnVerified"]) })
        expect(out.lines[0]).toStartWith("WARN genesis fork schedule: skipped: bun is needed")
        expect(out.counts).toBe("fails=0 warns=1")
    })

    it("runs the check in the node image under compose, with the container's settings", () => {
        // Stands in for `docker compose run`: the container gets the node's environment
        const expected = "compose run --rm --no-deps -T node bun scripts/genesis-schedule-check.ts"
        fs.writeFileSync(
            path.join(tools, "docker"),
            `#!${BASH}\n[ "$*" = "${expected}" ] || { echo "unexpected docker $*" >&2; exit 125; }\nshift 7\nexec "${BUN}" "$@"\n`,
        )
        fs.chmodSync(path.join(tools, "docker"), 0o755)
        const compose = JSON.stringify({ services: { node: {} } })
        const file = writeGenesis(["tlsnVerified"])
        const refused = check({}, compose, { DEMOS_GENESIS_FILE: file, EXPECTED_GENESIS_HASH: PIN })
        expect(refused.lines).toHaveLength(1)
        expect(refused.lines[0]).toStartWith(
            "FAIL genesis fork schedule: the node refuses to boot on it: the genesis does not declare tlsnVerified",
        )

        fs.writeFileSync(path.join(tools, "docker"), `#!${BASH}\necho "no such service: node" >&2\nexit 1\n`)
        const broken = check({}, compose)
        expect(broken.lines).toEqual([
            "FAIL genesis fork schedule: the node's boot check did not run (exit 1): no such service: node",
        ])
    }, 30_000)
})

describe("node-doctor --production web2 identity credentials under keylessWeb2Identity", () => {
    let dir: string
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-doctor-keyless-"))
        fs.symlinkSync(PYTHON3, path.join(dir, "python3"))
    })
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

    function genesisWith(keyless: unknown, raw?: string): string {
        const file = path.join(dir, "genesis.json")
        const forks = keyless === undefined ? {} : { keylessWeb2Identity: keyless }
        fs.writeFileSync(file, raw ?? JSON.stringify({ properties: { id: 4242, shardSize: 3 }, forks }))
        return file
    }

    /** The credential lines after check_genesis_file read `file`, every credential empty. */
    function credentialLines(file: string, token = ""): string[] {
        const settings = { DEMOS_GENESIS_FILE: file, DEMOS_SNAPSHOT_DIR: dir, GITHUB_TOKEN: token }
        const assign = Object.entries(settings)
            .map(([k, v]) => `NODE_ENV_VALUES[${k}]=${JSON.stringify(v)}`)
            .join("; ")
        const run = Bun.spawnSync(
            [BASH, "-c", `source "${doctor}"; ${assign}; check_genesis_file >/dev/null; check_web2_identity_credentials; check_github_token`],
            { env: { PATH: dir } },
        )
        return run.stdout.toString().trim().split("\n")
    }

    it("reports the credentials as not needed when the genesis schedules the fork at 0", () => {
        const lines = credentialLines(genesisWith({ activationHeight: 0 }), "ghp_expired")
        expect(lines).toEqual([
            "PASS GITHUB_TOKEN: not needed: the genesis schedules keylessWeb2Identity at 0, so GitHub identity links go through TLSNotary only",
            "PASS DISCORD_BOT_TOKEN: not needed: the genesis schedules keylessWeb2Identity at 0, so Discord identity links go through TLSNotary only",
            "PASS RAPID_API_KEY: not needed: the genesis schedules keylessWeb2Identity at 0, so Twitter/X identity links go through TLSNotary only",
        ])
    })

    it("reads a height written as 0.0 as 0, like the node", () => {
        const raw = '{"properties":{"id":4242,"shardSize":3},"forks":{"keylessWeb2Identity":{"activationHeight":0.0}}}'
        const lines = credentialLines(genesisWith(undefined, raw))
        expect(lines.filter(l => l.startsWith("FAIL"))).toEqual([])
        expect(lines).toHaveLength(3)
    })

    it("still fails empty credentials when the fork is absent, unscheduled or later", () => {
        for (const keyless of [
            undefined,
            { activationHeight: null },
            { activationHeight: 10 },
            { activationHeight: "0" },
            { activationHeight: false },
        ]) {
            const lines = credentialLines(genesisWith(keyless))
            expect([keyless, lines.filter(l => l.startsWith("FAIL")).map(l => l.split(":")[0])]).toEqual([
                keyless,
                ["FAIL GITHUB_TOKEN", "FAIL DISCORD_BOT_TOKEN", "FAIL RAPID_API_KEY"],
            ])
        }
    })
})
