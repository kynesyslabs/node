import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import dotenv from "dotenv"
import * as fs from "node:fs"
import * as path from "node:path"
import { runCli } from "./cli"
import { applyEnvChanges, parseEnv } from "./envFile"
import { fakeRunner, makeRoot, recorder, removeRoot } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

async function setup(argv: string[], env: Record<string, string> = {}) {
    const r = recorder()
    const code = await runCli(argv, {
        cwd: root,
        env,
        isTTY: false,
        say: r.say,
        runner: fakeRunner(),
        inDocker: false,
    })
    return { code, out: r.text() }
}

const envPath = () => path.join(root, ".env")
const WIZARD = ["--yes", "--only", "l2ps", "--l2ps-uid", "env_check", "--messaging", "--messaging-port", "3100"]

describe("applyEnvChanges keeps everything it does not own", () => {
    const BODY = [
        "# node settings",
        "",
        "PG_PASSWORD=pa=ss#word",
        'QUOTED="a # b"',
        "export KEEP_EXPORT=1",
        "L2PS_ZK_ENABLED_EXTRA=nope",
        "XL2PS_ZK_ENABLED=nope",
        "  INDENTED = spaced value  ",
        "NOVALUE",
        "EMPTY=",
        "# L2PS_ZK_ENABLED is described here, not set",
        "DUP=1",
        "DUP=2",
        "",
    ].join("\n")

    it("changes only the owned key and leaves every other byte alone", () => {
        const out = applyEnvChanges(BODY + "L2PS_ZK_ENABLED=false\n", { L2PS_ZK_ENABLED: "true" })
        expect(out).toBe(BODY + "L2PS_ZK_ENABLED=true\n")
    })

    it("appends a missing key once and keeps the original text as a prefix", () => {
        const out = applyEnvChanges(BODY, { L2PS_ZK_ENABLED: "true", L2PS_MESSAGING_PORT: "3100" })
        expect(out.startsWith(BODY)).toBe(true)
        expect(out.match(/^L2PS_ZK_ENABLED=/gm)).toHaveLength(1)
        expect(out.match(/^L2PS_MESSAGING_PORT=/gm)).toHaveLength(1)
        expect(dotenv.parse(out)).toMatchObject({
            PG_PASSWORD: "pa=ss",
            DUP: "2",
            L2PS_ZK_ENABLED: "true",
        })
    })

    it("is idempotent", () => {
        const once = applyEnvChanges(BODY, { L2PS_ZK_ENABLED: "true" })
        expect(applyEnvChanges(once, { L2PS_ZK_ENABLED: "true" })).toBe(once)
    })

    it("never leaves two active definitions of a key it wrote", () => {
        const text = "L2PS_ZK_ENABLED=false\nB=1\nL2PS_ZK_ENABLED=false\n"
        const out = applyEnvChanges(text, { L2PS_ZK_ENABLED: "true" })
        // dotenv takes the last duplicate, so that one has to carry the new value.
        expect(dotenv.parse(out).L2PS_ZK_ENABLED).toBe("true")
    })

    it("works on empty text, a lone newline and a file without a trailing newline", () => {
        expect(applyEnvChanges("", { A: "1" })).toContain("A=1\n")
        expect(dotenv.parse(applyEnvChanges("\n", { A: "1" }))).toEqual({ A: "1" })
        const out = applyEnvChanges("X=1", { A: "1" })
        expect(dotenv.parse(out)).toEqual({ X: "1", A: "1" })
        expect(out.endsWith("\n")).toBe(true)
    })

    it("keeps a byte order mark and the first entry readable", () => {
        const out = applyEnvChanges("﻿FIRST=1\nL2PS_ZK_ENABLED=false\n", { L2PS_ZK_ENABLED: "true" })
        expect(out.startsWith("﻿FIRST=1\n")).toBe(true)
        expect(dotenv.parse(out)).toMatchObject({ FIRST: "1", L2PS_ZK_ENABLED: "true" })
    })

    it("keeps CRLF files CRLF, with no bare line feed added", () => {
        const out = applyEnvChanges("A=1\r\n# c\r\nL2PS_ZK_ENABLED=false\r\n", { L2PS_ZK_ENABLED: "true", B: "2" })
        expect(out.replaceAll("\r\n", "")).not.toContain("\n")
        expect(dotenv.parse(out)).toMatchObject({ A: "1", L2PS_ZK_ENABLED: "true", B: "2" })
    })

    it("switches a commented example on without touching the surrounding comments", () => {
        const text = "# header\n#L2PS_ZK_ENABLED=false\n# footer\n"
        expect(applyEnvChanges(text, { L2PS_ZK_ENABLED: "true" })).toBe("# header\nL2PS_ZK_ENABLED=true\n# footer\n")
    })

    it("prefers the active line over a commented example", () => {
        const text = "#L2PS_ZK_ENABLED=false\nL2PS_ZK_ENABLED=false\n"
        expect(applyEnvChanges(text, { L2PS_ZK_ENABLED: "true" })).toBe("#L2PS_ZK_ENABLED=false\nL2PS_ZK_ENABLED=true\n")
    })

    it("turns an empty or valueless entry into a value", () => {
        expect(dotenv.parse(applyEnvChanges("L2PS_ZK_ENABLED=\n", { L2PS_ZK_ENABLED: "true" }))).toEqual({ L2PS_ZK_ENABLED: "true" })
        expect(dotenv.parse(applyEnvChanges("L2PS_ZK_ENABLED\n", { L2PS_ZK_ENABLED: "true" }))).toEqual({ L2PS_ZK_ENABLED: "true" })
    })

    it("keeps `export` so a shell that sources the file still exports the key", () => {
        const out = applyEnvChanges("export L2PS_MESSAGING_ENABLED=false\nB=2\n", { L2PS_MESSAGING_ENABLED: "true" })
        expect(out).toBe("export L2PS_MESSAGING_ENABLED=true\nB=2\n")
    })

    it("keeps the comment at the end of an edited line", () => {
        const out = applyEnvChanges("L2PS_MESSAGING_ENABLED=false # off until the subnet exists\n", { L2PS_MESSAGING_ENABLED: "true" })
        expect(out).toBe("L2PS_MESSAGING_ENABLED=true # off until the subnet exists\n")
        expect(dotenv.parse(out).L2PS_MESSAGING_ENABLED).toBe("true")
    })

    it("does not treat a # inside a quoted old value as a comment", () => {
        const out = applyEnvChanges('KEY="a # b"\n', { KEY: "c" })
        expect(dotenv.parse(out).KEY).toBe("c")
    })
})

describe("parseEnv reads values the way dotenv (and Bun) do", () => {
    const lines = [
        "K=v",
        "K = v",
        "export K=v",
        "K=v # c",
        "K=v#c",
        'K="v # x"',
        "K='v'",
        "K=`v`",
        'K="a"#c',
        "K=",
        "K=a=b",
        "K=a b",
        "K='a' # c",
        '  K="x"  ',
        "K=true #on",
    ]
    for (const line of lines) {
        it(JSON.stringify(line), () => {
            expect(parseEnv(line)).toEqual(dotenv.parse(line))
        })
    }
})

describe("the wizard's .env write", () => {
    it("writes through a symlinked .env and keeps the link", async () => {
        const real = path.join(root, "managed.env")
        fs.writeFileSync(real, "A=1\n")
        fs.symlinkSync(real, envPath())
        const { code } = await setup(WIZARD)
        expect(code).toBe(0)
        expect(fs.lstatSync(envPath()).isSymbolicLink()).toBe(true)
        expect(dotenv.parse(fs.readFileSync(real, "utf8"))).toMatchObject({ A: "1", L2PS_MESSAGING_ENABLED: "true", L2PS_MESSAGING_PORT: "3100" })
    })

    it("follows a chain of symlinks to the real file", async () => {
        const real = path.join(root, "real.env")
        fs.writeFileSync(real, "A=1\n")
        fs.symlinkSync(real, path.join(root, "hop.env"))
        fs.symlinkSync(path.join(root, "hop.env"), envPath())
        await setup(WIZARD)
        expect(fs.lstatSync(envPath()).isSymbolicLink()).toBe(true)
        expect(fs.readFileSync(real, "utf8")).toContain("L2PS_MESSAGING_PORT=3100")
    })

    it("creates the target of a dangling .env symlink instead of replacing the link", async () => {
        const target = path.join(root, "later.env")
        fs.symlinkSync(target, envPath())
        const { code } = await setup(WIZARD)
        expect(code).toBe(0)
        expect(fs.lstatSync(envPath()).isSymbolicLink()).toBe(true)
        expect(fs.readFileSync(target, "utf8")).toContain("L2PS_MESSAGING_PORT=3100")
    })

    it("refuses to rewrite a read-only .env and hands the lines over", async () => {
        fs.writeFileSync(envPath(), "A=1\n", { mode: 0o444 })
        const { code, out } = await setup(WIZARD)
        expect(fs.readFileSync(envPath(), "utf8")).toBe("A=1\n")
        expect(out).toContain("L2PS_MESSAGING_PORT=3100")
        expect(out).toContain("by hand")
        expect(code).toBe(1)
    })

    it("exits non-zero when .env is a directory, and says which lines to add", async () => {
        fs.mkdirSync(envPath())
        const { code, out } = await setup(WIZARD)
        expect(code).toBe(1)
        expect(out).toContain("Could not write .env")
        expect(out).toContain("L2PS_MESSAGING_PORT=3100")
        expect(fs.statSync(envPath()).isDirectory()).toBe(true)
    })

    it("exits non-zero when the env file cannot be created in an unwritable directory", async () => {
        const sub = path.join(root, "ro")
        fs.mkdirSync(sub)
        fs.chmodSync(sub, 0o555)
        try {
            const { code, out } = await setup([...WIZARD, "--env-file", "ro/.env"])
            expect(code).toBe(1)
            expect(out).toContain("by hand")
        } finally {
            fs.chmodSync(sub, 0o755)
        }
    })

    it("keeps comments, duplicates and an unrelated entry that looks like ours", async () => {
        const before = [
            "# production node",
            "PG_PASSWORD=a=b#c",
            "L2PS_MESSAGING_PORT_NOTES=keep",
            "export RPC_PORT=53550",
            "",
        ].join("\n")
        fs.writeFileSync(envPath(), before)
        await setup(WIZARD)
        const after = fs.readFileSync(envPath(), "utf8")
        expect(after.startsWith(before)).toBe(true)
        expect(after.match(/^L2PS_MESSAGING_ENABLED=/gm)).toHaveLength(1)
        const got = dotenv.parse(after)
        expect(got).toMatchObject({ PG_PASSWORD: "a=b", L2PS_MESSAGING_PORT_NOTES: "keep", RPC_PORT: "53550" })
    })

    it("a second identical run changes nothing and creates no extra backup", async () => {
        fs.writeFileSync(envPath(), "A=1\n")
        await setup(WIZARD)
        const first = fs.readFileSync(envPath(), "utf8")
        const files = fs.readdirSync(root).sort()
        await setup(WIZARD)
        expect(fs.readFileSync(envPath(), "utf8")).toBe(first)
        expect(fs.readdirSync(root).sort()).toEqual(files)
    })

    it("never makes an existing .env more readable, and creates a new one at 600", async () => {
        fs.writeFileSync(envPath(), "A=1\n", { mode: 0o640 })
        await setup(WIZARD)
        expect(fs.statSync(envPath()).mode & 0o777 & ~0o640).toBe(0)
        await setup([...WIZARD, "--env-file", "fresh.env"])
        expect(fs.statSync(path.join(root, "fresh.env")).mode & 0o777).toBe(0o600)
    })

    it("keeps the BOM and the CRLF endings of the file it edits", async () => {
        fs.writeFileSync(envPath(), "\uFEFFFIRST=1\r\n# note\r\nL2PS_MESSAGING_PORT=3006\r\n")
        await setup([...WIZARD, "--force"])
        const after = fs.readFileSync(envPath(), "utf8")
        expect(after.startsWith("\uFEFFFIRST=1\r\n# note\r\n")).toBe(true)
        expect(after.replaceAll("\r\n", "")).not.toContain("\n")
        expect(dotenv.parse(after)).toMatchObject({ FIRST: "1", L2PS_MESSAGING_PORT: "3100" })
    })
})
