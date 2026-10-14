import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { HELP, parseSetupArgs, UsageError } from "./args"
import { runCli } from "./cli"
import { HEX_IV, HEX_KEY, fakeRunner, makeRoot, recorder, removeRoot, writeSubnet } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

async function cli(argv: string[], env: Record<string, string> = {}, cwd = root) {
    const r = recorder()
    const code = await runCli(argv, { cwd, env, isTTY: false, say: r.say, runner: fakeRunner(), inDocker: false })
    return { code, out: r.text(), lines: r.lines }
}

function tree(dir: string): string[] {
    const out: string[] = []
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name)
            out.push(p + (e.isDirectory() ? "/" : `:${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`))
            if (e.isDirectory()) walk(p)
        }
    }
    walk(dir)
    return out.sort()
}

describe("--check --json is valid JSON on every path", () => {
    const parse = (out: string) => JSON.parse(out) as { ok: boolean; items?: unknown[]; error?: string }

    it("on a healthy node", async () => {
        const { code, out } = await cli(["--check", "--json"])
        expect(code).toBe(0)
        expect(parse(out).ok).toBe(true)
    })

    it("with problems, and exit code 1", async () => {
        writeSubnet(root, "broken", { key: null })
        const { code, out } = await cli(["--check", "--json"])
        expect(code).toBe(1)
        const j = parse(out)
        expect(j.ok).toBe(false)
        expect(JSON.stringify(j.items)).toContain("private_key.txt is missing")
    })

    const bad: Array<[string, string[], Record<string, string>]> = [
        ["a bad --only", ["--only", "bogus"], {}],
        ["an unknown flag", ["--frobnicate"], {}],
        ["a flag missing its value", ["--l2ps-uid"], {}],
        ["an unexpected positional", ["stray"], {}],
        ["an inline value on a flag that takes none", ["--yes=maybe"], {}],
        ["an invalid DEMOS_SETUP_* variable", [], { DEMOS_SETUP_YES: "perhaps" }],
        ["an invalid port", ["--messaging-port", "99999"], {}],
    ]
    for (const [name, extra, env] of bad) {
        it(`for ${name}: still one JSON document, ok false, exit 2`, async () => {
            const { code, out } = await cli(["--check", "--json", ...extra], env)
            expect(code).toBe(2)
            const j = parse(out)
            expect(j.ok).toBe(false)
            expect(typeof j.error).toBe("string")
        })
    }

    it("when data/l2ps is a file, not a directory", async () => {
        fs.mkdirSync(path.join(root, "data"))
        fs.writeFileSync(path.join(root, "data", "l2ps"), "oops")
        const { out } = await cli(["--check", "--json"])
        expect(typeof parse(out).ok).toBe("boolean")
    })

    it("when a key file is a directory and config.json is binary", async () => {
        const dir = writeSubnet(root, "weird", { key: null })
        fs.mkdirSync(path.join(dir, "private_key.txt"))
        writeSubnet(root, "bin", { config: "\u0000\u0001\u0002" })
        const { out } = await cli(["--check", "--json"])
        expect(typeof parse(out).ok).toBe("boolean")
    })

    it("when the working directory does not exist", async () => {
        const { out } = await cli(["--check", "--json"], {}, path.join(root, "gone"))
        expect(typeof parse(out).ok).toBe("boolean")
    })

    it("prints nothing but the document", async () => {
        const { lines } = await cli(["--check", "--json"])
        expect(lines).toHaveLength(1)
    })
})

describe("--check writes nothing", () => {
    it("leaves the tree byte and mtime identical, even with problems", async () => {
        writeSubnet(root, "a", { key: null })
        fs.writeFileSync(path.join(root, ".env"), "L2PS_MESSAGING_ENABLED=true\n")
        const before = tree(root)
        await cli(["--check"])
        await cli(["--check", "--json", "--force", "--dry-run", "--yes"])
        expect(tree(root)).toEqual(before)
    })
})

describe("exit codes", () => {
    it("are documented in --help", () => {
        expect(HELP).toContain("Exit codes")
        for (const code of ["0", "1", "2", "130"]) expect(HELP).toMatch(new RegExp(`\\b${code}\\b`))
    })

    it("--help is 0, a usage mistake is 2, a missing answer or a problem is 1", async () => {
        expect((await cli(["--help"])).code).toBe(0)
        expect((await cli(["-h", "--bogus"])).code).toBe(2)
        expect((await cli(["--yes", "--l2ps"])).code).toBe(1)
        expect((await cli(["--yes", "--l2ps-uid", "x", "--l2ps-role", "join"])).code).toBe(1)
        writeSubnet(root, "broken", { key: null, iv: null, config: "{" })
        expect((await cli(["--check"])).code).toBe(1)
    })

    it("a usage error names the --help command and writes nothing", async () => {
        const before = tree(root)
        const { code, out } = await cli(["--yes", "--l2ps-uid", "bad uid!"])
        expect(code).toBe(2)
        expect(out).toContain("--help")
        expect(tree(root)).toEqual(before)
    })
})

describe("values are validated, not coerced", () => {
    const rejects = (argv: string[], env: Record<string, string> = {}) => {
        expect(() => parseSetupArgs(argv, env)).toThrow(UsageError)
    }

    it("subnet ids: letters, digits, _ and - up to the documented length", () => {
        expect(parseSetupArgs(["--l2ps-uid", "a".repeat(255)], {}).uid).toBe("a".repeat(255))
        expect(HELP).toContain("up to 255")
        for (const bad of ["a".repeat(256), "a".repeat(5000), "", "   ", "../x", "a/b", "a b", "..", ".", "ünï", "a\u0000b", "a;b", "-"+"/"]) {
            rejects(["--l2ps-uid", bad])
        }
        rejects([], { DEMOS_SETUP_L2PS_UID: "   " })
    })

    it("retention: whole days, bounded so it prints back as the same digits", () => {
        expect(parseSetupArgs(["--history-retention-days", "0030"], {}).retentionDays).toBe(30)
        for (const bad of ["-1", "1.5", "1e3", "0x10", "abc", "", " ", "1000000000000000000000", "99999999999999999999999999", "٣"]) {
            rejects(["--history-retention-days", bad])
        }
    })

    it("ports: 1..65535 in plain digits", () => {
        expect(parseSetupArgs(["--messaging-port", " 03006 "], {}).messagingPort).toBe(3006)
        for (const bad of ["0", "65536", "-1", "3006.5", "1e3", "0x1F90", "abc", "", "٣٠٠٦", "99999999999999999999"]) {
            rejects(["--messaging-port", bad])
        }
    })

    it("RPC urls: http(s) only, no credentials in a world-readable config", () => {
        expect(parseSetupArgs(["--l2ps-rpc", "http://a:1/, https://b:2"], {}).rpcs).toEqual(["http://a:1", "https://b:2"])
        for (const bad of ["file:///etc/passwd", "ftp://a", "javascript:alert(1)", "http://", "not a url", "http://user:secret@host:53550", "http://user@host"]) {
            rejects(["--l2ps-rpc", bad])
        }
    })

    it("booleans accept the documented spellings and nothing else", () => {
        for (const v of ["true", "TRUE", " yes ", "1", "on", "y"]) expect(parseSetupArgs([], { DEMOS_SETUP_YES: v }).yes).toBe(true)
        for (const v of ["false", "0", "off", "n"]) expect(parseSetupArgs([], { DEMOS_SETUP_YES: v }).yes).toBe(false)
        for (const v of ["2", "tru", "enable", " "]) rejects([], { DEMOS_SETUP_YES: v })
        expect(parseSetupArgs([], { DEMOS_SETUP_YES: "" }).yes).toBe(false)
    })

    it("flags win over variables, and --no-x beats an enabling variable", () => {
        expect(parseSetupArgs(["--l2ps-uid", "from_flag"], { DEMOS_SETUP_L2PS_UID: "from_env" }).uid).toBe("from_flag")
        expect(parseSetupArgs(["--no-messaging"], { DEMOS_SETUP_MESSAGING: "true" }).messaging).toBe(false)
    })
})

describe("flags that contradict each other are refused, not half-obeyed", () => {
    it("--no-l2ps together with subnet answers", async () => {
        const { code, out } = await cli(["--yes", "--no-l2ps", "--l2ps-uid", "x"])
        expect(code).toBe(2)
        expect(out).toContain("--no-l2ps")
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
    })

    it("--l2ps-role create together with an imported key or IV", async () => {
        for (const extra of [["--l2ps-key-file", "k"], ["--l2ps-iv-file", "i"]]) {
            const { code } = await cli(["--yes", "--l2ps-uid", "x", "--l2ps-role", "create", ...extra])
            expect(code).toBe(2)
        }
        const viaEnv = await cli(["--yes"], { DEMOS_SETUP_L2PS_UID: "x", DEMOS_SETUP_L2PS_ROLE: "create", DEMOS_SETUP_L2PS_KEY: HEX_KEY, DEMOS_SETUP_L2PS_IV: HEX_IV })
        expect(viaEnv.code).toBe(2)
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
    })

    it("a flag still wins over a lingering variable instead of being blocked by it", async () => {
        const { code } = await cli(["--yes", "--l2ps-uid", "x", "--l2ps-role", "create"], { DEMOS_SETUP_L2PS_KEY: HEX_KEY, DEMOS_SETUP_L2PS_IV: HEX_IV })
        expect(code).toBe(0)
        expect(fs.readFileSync(path.join(root, "data/l2ps/x/private_key.txt"), "utf8").trim()).not.toBe(HEX_KEY)
        const off = await cli(["--yes", "--no-l2ps"], { DEMOS_SETUP_L2PS_UID: "y" })
        expect(off.code).toBe(0)
        expect(fs.existsSync(path.join(root, "data/l2ps/y"))).toBe(false)
    })

    it("--dry-run with --force still writes nothing and says what it would replace", async () => {
        writeSubnet(root, "x")
        const other = "11".repeat(32)
        const before = tree(root)
        const { code, out } = await cli(["--yes", "--dry-run", "--force", "--l2ps-uid", "x", "--l2ps-role", "join", "--l2ps-key-file", "k"], { DEMOS_SETUP_L2PS_IV: HEX_IV })
        // The key file does not exist, so this is a refused answer, not a plan.
        expect(code).toBe(1)
        fs.writeFileSync(path.join(root, "k"), other)
        const plan = await cli(["--yes", "--dry-run", "--force", "--l2ps-uid", "x", "--l2ps-role", "join", "--l2ps-key-file", "k"], { DEMOS_SETUP_L2PS_IV: HEX_IV })
        expect(plan.code).toBe(0)
        expect(plan.out).toContain("would replace")
        expect(tree(root).filter(p => !p.endsWith("/k") && !/\/k:/.test(p))).toEqual(before.filter(p => !/\/k:/.test(p)))
        expect(out).not.toContain(other)
    })
})

describe("secrets never appear in output", () => {
    it("not when they are rejected, not on a dry run, not in the result table", async () => {
        const secret = "9f".repeat(32)
        const cases: Array<[string[], Record<string, string>]> = [
            [["--yes", "--l2ps-uid", "x"], { DEMOS_SETUP_L2PS_KEY: secret + "zz", DEMOS_SETUP_L2PS_IV: HEX_IV }],
            [["--yes", "--l2ps-uid", "x"], { DEMOS_SETUP_L2PS_KEY: secret.slice(2), DEMOS_SETUP_L2PS_IV: HEX_IV }],
            [["--yes", "--dry-run", "--l2ps-uid", "x"], { DEMOS_SETUP_L2PS_KEY: secret, DEMOS_SETUP_L2PS_IV: HEX_IV }],
            [["--yes", "--l2ps-uid", "x"], { DEMOS_SETUP_L2PS_KEY: secret, DEMOS_SETUP_L2PS_IV: HEX_IV }],
        ]
        for (const [argv, env] of cases) {
            const { out } = await cli(argv, env)
            expect(out).not.toContain(secret)
            expect(out).not.toContain(secret.slice(2))
            expect(out).not.toContain(HEX_IV)
        }
    })

    it("not when a key file is unreadable or holds the wrong thing", async () => {
        fs.writeFileSync(path.join(root, "k"), "not hex but secret-ish words")
        const { out } = await cli(["--yes", "--l2ps-uid", "x", "--l2ps-key-file", "k", "--l2ps-iv-file", "k"])
        expect(out).not.toContain("secret-ish")
    })
})

describe("an over-long subnet id", () => {
    it("is a usage error, never a raw mkdir failure", async () => {
        const { code, out } = await cli(["--yes", "--l2ps-uid", "a".repeat(300)])
        expect(code).toBe(2)
        expect(out).toContain("--l2ps-uid")
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
    })
})
