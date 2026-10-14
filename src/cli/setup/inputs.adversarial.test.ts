import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import dotenv from "dotenv"
import * as fs from "node:fs"
import * as path from "node:path"
import { HELP, SETUP_ENV_NAMES, parseSetupArgs } from "./args"
import { runCli } from "./cli"
import { HEX_IV, HEX_KEY, fakeRunner, makeRoot, recorder, removeRoot } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

const repo = path.resolve(import.meta.dir, "../../..")

async function cli(argv: string[], env: Record<string, string> = {}) {
    const r = recorder()
    const code = await runCli(argv, { cwd: root, env, isTTY: false, say: r.say, runner: fakeRunner(), inDocker: false })
    return { code, out: r.text() }
}
const keyOf = (uid: string) => fs.readFileSync(path.join(root, "data/l2ps", uid, "private_key.txt"), "utf8")

describe("key and IV files", () => {
    it("are normalised whatever an editor or a copy-paste put around the hex", async () => {
        const messy = `\uFEFF0X${HEX_KEY.toUpperCase().slice(0, 32)}\r\n  ${HEX_KEY.toUpperCase().slice(32)}\r\n\r\n`
        fs.writeFileSync(path.join(root, "k"), messy)
        fs.writeFileSync(path.join(root, "i"), `\t${HEX_IV}`)
        const { code } = await cli(["--yes", "--l2ps-uid", "s", "--l2ps-key-file", "k", "--l2ps-iv-file", "i"])
        expect(code).toBe(0)
        expect(keyOf("s")).toBe(HEX_KEY + "\n")
    })

    it("a file that is not a key ends quickly with an error that does not repeat its content", async () => {
        const started = Date.now()
        for (const bad of ["/dev/zero", "/dev/urandom"]) {
            const { code, out } = await cli(["--yes", "--l2ps-uid", "s", "--l2ps-key-file", bad, "--l2ps-iv-file", bad])
            expect([bad, code]).toEqual([bad, 1])
            expect(out.length).toBeLessThan(2000)
        }
        fs.writeFileSync(path.join(root, "big"), "ab".repeat(5_000_000))
        const big = await cli(["--yes", "--l2ps-uid", "s", "--l2ps-key-file", "big", "--l2ps-iv-file", "big"])
        expect(big.code).toBe(1)
        expect(Date.now() - started).toBeLessThan(10_000)
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
    })

    it("a missing file, a directory and an unreadable file are plain errors, never a half-written subnet", async () => {
        fs.mkdirSync(path.join(root, "adir"))
        fs.writeFileSync(path.join(root, "locked"), HEX_KEY, { mode: 0o000 })
        for (const f of ["nope", "adir", "locked"]) {
            const { code, out } = await cli(["--yes", "--l2ps-uid", "s", "--l2ps-key-file", f], { DEMOS_SETUP_L2PS_IV: HEX_IV })
            expect([f, code]).toEqual([f, 1])
            expect(out).toContain(f)
            expect(fs.existsSync(path.join(root, "data"))).toBe(false)
        }
    })
})

describe("an existing .env that is large or odd", () => {
    it("keeps a megabyte line, thousands of lines and non-ASCII text exactly", async () => {
        const lines = [
            "# комментарий with ünïcode and 日本語",
            `HUGE=${"x".repeat(1_000_000)}`,
            ...Array.from({ length: 5000 }, (_, i) => `KEY_${i}=value_${i} # note ${i}`),
            "\tTAB_INDENTED=1",
            "EQUALS=a=b=c",
            "",
        ]
        const before = lines.join("\n")
        fs.writeFileSync(path.join(root, ".env"), before)
        const started = Date.now()
        const { code } = await cli(["--yes", "--only", "l2ps", "--l2ps-uid", "s", "--messaging", "--messaging-port", "3100"])
        expect(code).toBe(0)
        const after = fs.readFileSync(path.join(root, ".env"), "utf8")
        expect(after.startsWith(before)).toBe(true)
        expect(dotenv.parse(after)).toMatchObject({ EQUALS: "a=b=c", KEY_4999: "value_4999", L2PS_MESSAGING_PORT: "3100" })
        expect(Date.now() - started).toBeLessThan(10_000)
    })
})

describe("the documentation matches the parser", () => {
    const known = (flag: string) => {
        try {
            parseSetupArgs([flag, "x"], {})
        } catch (e) {
            return !String((e as Error).message).startsWith("Unknown option")
        }
        return true
    }

    it("every flag in --help and in INSTALL.md exists", () => {
        const install = fs.readFileSync(path.join(repo, "INSTALL.md"), "utf8")
        const section = install.slice(install.indexOf("## L2PS and ZK setup"), install.indexOf("## Security Notes"))
        const shown = new Set([...HELP.matchAll(/--[a-z][a-z0-9-]*/g), ...section.matchAll(/--[a-z][a-z0-9-]*/g)].map(m => m[0]))
        const unknown = [...shown].filter(f => !known(f) && !known(f.replace(/^--no-/, "--")))
        // docker/compose flags mentioned in the same section are not setup flags
        expect(unknown.filter(f => !["--profile", "--proxy"].includes(f))).toEqual([])
    })

    it("every variable the parser reads is passed through by docker-compose.yml, except the secrets", () => {
        const compose = fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8")
        const missing = SETUP_ENV_NAMES.filter(n => !compose.includes(`${n}:`))
        expect(missing).toEqual([])
        // Values in the compose file would show up in `docker inspect`.
        expect(compose).not.toMatch(/DEMOS_SETUP_L2PS_(KEY|IV):/)
    })

    it("every variable named in .env.example or the compose file is one the parser reads", () => {
        const text = fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8") + fs.readFileSync(path.join(repo, ".env.example"), "utf8")
        const named = new Set([...text.matchAll(/DEMOS_SETUP_[A-Z0-9_]+/g)].map(m => m[0]))
        const allowed = new Set([...SETUP_ENV_NAMES, "DEMOS_SETUP_STRICT", "DEMOS_SETUP_L2PS_KEY", "DEMOS_SETUP_L2PS_IV", "DEMOS_SETUP_"])
        expect([...named].filter(n => !allowed.has(n) && !n.endsWith("_"))).toEqual([])
    })
})
