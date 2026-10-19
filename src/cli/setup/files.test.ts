import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { applyEnvChanges, diffEnv, parseEnv } from "./envFile"
import { writeFileGuarded } from "./files"
import { buildSubnetFiles, generateKeyMaterial, inspectSubnet } from "./l2ps"
import { validateIvHex, validateKeyHex } from "./validate"
import { makeRoot, removeRoot } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

describe("writeFileGuarded", () => {
    it("creates a new file with the requested mode", () => {
        const file = path.join(root, "a", "secret.txt")
        expect(writeFileGuarded(file, "v1\n", { mode: 0o600, overwrite: false }).status).toBe("created")
        expect(fs.readFileSync(file, "utf8")).toBe("v1\n")
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    })

    it("does not overwrite an existing file with different content", () => {
        const file = path.join(root, "k.txt")
        fs.writeFileSync(file, "original\n")
        const out = writeFileGuarded(file, "new\n", { mode: 0o600, overwrite: false })
        expect(out.status).toBe("kept")
        expect(fs.readFileSync(file, "utf8")).toBe("original\n")
        expect(fs.readdirSync(root).filter(f => f.startsWith("k.txt."))).toEqual([])
    })

    it("reports identical content as unchanged and leaves it alone", () => {
        const file = path.join(root, "k.txt")
        fs.writeFileSync(file, "same\n")
        expect(writeFileGuarded(file, "same\n", { mode: 0o600, overwrite: false }).status).toBe("unchanged")
    })

    describe("a symbolic link at the path", () => {
        // The target sits outside the directory being written, with a loose mode
        // that a write through the link would have tightened.
        function linked() {
            const outside = fs.mkdtempSync(path.join(root, "outside-"))
            const target = path.join(outside, "real.key")
            fs.writeFileSync(target, "same\n", { mode: 0o644 })
            fs.chmodSync(target, 0o644)
            const file = path.join(root, "k.txt")
            fs.symlinkSync(target, file)
            return { target, file }
        }

        it("is never called unchanged, even when the target holds the same content, and is left alone without overwrite", () => {
            const { target, file } = linked()
            expect(writeFileGuarded(file, "same\n", { mode: 0o600, overwrite: false }).status).toBe("link")
            expect(fs.lstatSync(file).isSymbolicLink()).toBe(true)
            expect(fs.statSync(target).mode & 0o777).toBe(0o644)
        })

        it("is replaced by a private regular file with overwrite; the target is untouched and the backup is the link", () => {
            const { target, file } = linked()
            const out = writeFileGuarded(file, "same\n", { mode: 0o600, overwrite: true })
            expect(out.status).toBe("replaced")
            expect(fs.lstatSync(file).isSymbolicLink()).toBe(false)
            expect(fs.statSync(file).mode & 0o777).toBe(0o600)
            expect(fs.readFileSync(file, "utf8")).toBe("same\n")
            expect(fs.readFileSync(target, "utf8")).toBe("same\n")
            expect(fs.statSync(target).mode & 0o777).toBe(0o644)
            const backup = (out as { backup: string }).backup
            expect(fs.lstatSync(backup).isSymbolicLink()).toBe(true)
            expect(fs.readlinkSync(backup)).toBe(target)
        })

        it("a dangling link is replaced by a regular file with overwrite and refused without", () => {
            const file = path.join(root, "d.txt")
            fs.symlinkSync(path.join(root, "nowhere"), file)
            expect(writeFileGuarded(file, "v\n", { mode: 0o600, overwrite: false }).status).toBe("link")
            expect(writeFileGuarded(file, "v\n", { mode: 0o600, overwrite: true }).status).toBe("replaced")
            expect(fs.lstatSync(file).isSymbolicLink()).toBe(false)
        })
    })

    it("replaces only when told to and keeps a private backup", () => {
        const file = path.join(root, "k.txt")
        fs.writeFileSync(file, "original\n")
        const out = writeFileGuarded(file, "new\n", { mode: 0o600, overwrite: true }, () => 42)
        expect(out).toEqual({ status: "replaced", backup: `${file}.bak-42` })
        expect(fs.readFileSync(file, "utf8")).toBe("new\n")
        expect(fs.readFileSync(`${file}.bak-42`, "utf8")).toBe("original\n")
        expect(fs.statSync(`${file}.bak-42`).mode & 0o777).toBe(0o600)
    })
})

describe("file modes and failure cleanup", () => {
    it("never widens a mode: an operator's 600 config stays 600, a 644 key is tightened", () => {
        const cfg = path.join(root, "config.json")
        fs.writeFileSync(cfg, "{}\n", { mode: 0o600 })
        expect(writeFileGuarded(cfg, "{}\n", { mode: 0o644, overwrite: false }).status).toBe("unchanged")
        expect(fs.statSync(cfg).mode & 0o777).toBe(0o600)
        writeFileGuarded(cfg, "{\"a\":1}\n", { mode: 0o644, overwrite: true })
        expect(fs.statSync(cfg).mode & 0o777).toBe(0o600)

        const key = path.join(root, "key.txt")
        fs.writeFileSync(key, "k\n", { mode: 0o644 })
        fs.chmodSync(key, 0o644)
        writeFileGuarded(key, "k\n", { mode: 0o600, overwrite: false })
        expect(fs.statSync(key).mode & 0o777).toBe(0o600)
    })

    it("removes its temporary file when the final rename fails", () => {
        const file = path.join(root, "k.txt")
        const failing = () => {
            throw new Error("rename failed")
        }
        expect(() => writeFileGuarded(file, "v\n", { mode: 0o600, overwrite: false }, Date.now, failing)).toThrow("rename failed")
        expect(fs.readdirSync(root).filter(f => f.includes(".tmp-"))).toEqual([])
        expect(fs.existsSync(file)).toBe(false)
    })
})

describe("subnet file generation", () => {
    it("writes a layout the node loader accepts, with valid key material", () => {
        const { keyHex, ivHex } = generateKeyMaterial()
        expect(validateKeyHex(keyHex).ok).toBe(true)
        expect(validateIvHex(ivHex).ok).toBe(true)
        expect(generateKeyMaterial().keyHex).not.toBe(keyHex)

        const files = buildSubnetFiles({ uid: "demo_1", rpcs: ["http://a:1"], keyHex, ivHex })
        for (const f of files) {
            writeFileGuarded(path.join(root, f.rel), f.content, { mode: f.mode, overwrite: false })
        }
        const status = inspectSubnet(root, "demo_1")
        expect(status.state).toBe("ok")
        expect(status.warnings).toEqual([])

        const cfg = JSON.parse(fs.readFileSync(path.join(root, "data/l2ps/demo_1/config.json"), "utf8"))
        expect(cfg).toEqual({
            uid: "demo_1",
            enabled: true,
            config: { created_at_block: 0, known_rpcs: ["http://a:1"] },
            keys: {
                private_key_path: "data/l2ps/demo_1/private_key.txt",
                iv_path: "data/l2ps/demo_1/iv.txt",
            },
        })
        const keyFile = path.join(root, "data/l2ps/demo_1/private_key.txt")
        expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
        expect(fs.readFileSync(keyFile, "utf8").trim()).toBe(keyHex)
    })

    it("marks key material as secret so it is never printed", () => {
        const files = buildSubnetFiles({ uid: "x", rpcs: ["http://a:1"], keyHex: "ab".repeat(32), ivHex: "cd".repeat(16) })
        expect(files.filter(f => f.secret).map(f => path.basename(f.rel))).toEqual(["private_key.txt", "iv.txt"])
        expect(files.find(f => f.rel.endsWith("config.json"))?.secret).toBe(false)
    })
})

describe("env file editing", () => {
    it("parses keys, quotes and trailing comments", () => {
        expect(parseEnv("A=1\n# B=2\nexport C=\"x y\"\nD=z # note\n")).toEqual({ A: "1", C: "x y", D: "z" })
    })

    it("edits in place, switches on commented examples and appends the rest", () => {
        const text = "A=1\nL2PS_ZK_ENABLED=false\n#L2PS_MESSAGING_PORT=3006\nB=2\n"
        const out = applyEnvChanges(text, {
            L2PS_ZK_ENABLED: "true",
            L2PS_MESSAGING_PORT: "4000",
            L2PS_HISTORY_RETENTION_DAYS: "30",
        })
        const parsed = parseEnv(out)
        expect(parsed).toMatchObject({ A: "1", B: "2", L2PS_ZK_ENABLED: "true", L2PS_MESSAGING_PORT: "4000", L2PS_HISTORY_RETENTION_DAYS: "30" })
        expect(out.split("\n").indexOf("L2PS_ZK_ENABLED=true")).toBe(1)
        expect(out).toContain("# --- L2PS / ZK (written by `bun run setup`) ---")
        expect(out.endsWith("\n")).toBe(true)
    })

    it("strips the quotes of a quoted value that carries a trailing comment", () => {
        expect(parseEnv("KEY=\"v\" # why\nOTHER='o p' # c\nPLAIN=x # c\n")).toEqual({ KEY: "v", OTHER: "o p", PLAIN: "x" })
    })

    it("edits the last duplicate, which is the one dotenv uses", () => {
        const text = "X=first\nA=1\nX=second\n"
        expect(parseEnv(text).X).toBe("second")
        const out = applyEnvChanges(text, { X: "new" })
        expect(out).toBe("X=first\nA=1\nX=new\n")
        expect(parseEnv(out).X).toBe("new")
    })

    it("keeps CRLF line endings, for edited and appended lines alike", () => {
        const out = applyEnvChanges("A=1\r\nL2PS_ZK_ENABLED=false\r\n", { L2PS_ZK_ENABLED: "true", NEW_KEY: "1" })
        expect(out.replaceAll("\r\n", "")).not.toContain("\n")
        expect(out).toContain("L2PS_ZK_ENABLED=true\r\n")
        expect(out).toContain("NEW_KEY=1\r\n")
        expect(parseEnv(out)).toMatchObject({ A: "1", L2PS_ZK_ENABLED: "true", NEW_KEY: "1" })
    })

    it("starts a fresh file when there is none", () => {
        expect(parseEnv(applyEnvChanges("", { X: "1" }))).toEqual({ X: "1" })
    })

    it("splits wanted values into add, same and conflict", () => {
        const d = diffEnv({ A: "1", B: "2" }, { A: "1", B: "9", C: "3" })
        expect(d.same).toEqual(["A"])
        expect(d.conflict).toEqual([{ key: "B", from: "2", to: "9" }])
        expect(d.add).toEqual([{ key: "C", to: "3" }])
    })
})
