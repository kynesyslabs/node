import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { runCli } from "./cli"
import { AS_USER, HEX_IV, HEX_KEY, fakeRunner, isRoot, makeRoot, recorder, removeRoot, writeSubnet } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

async function cli(argv: string[], env: Record<string, string> = {}) {
    const r = recorder()
    const code = await runCli(argv, { cwd: root, env, isTTY: false, say: r.say, runner: fakeRunner(), inDocker: false })
    return { code, out: r.text() }
}

const sub = (uid: string, f: string) => path.join(root, "data/l2ps", uid, f)
const read = (p: string) => fs.readFileSync(p, "utf8")

/** Every file under root with its bytes and mode, so any change shows up. */
function snapshot(): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name)
            if (e.isDirectory()) walk(p)
            else out[path.relative(root, p)] = `${fs.statSync(p).mode & 0o777}:${fs.readFileSync(p, "utf8")}`
        }
    }
    walk(root)
    return out
}

const BASE = ["--yes", "--l2ps-uid", "s1", "--l2ps-rpc", "http://10.0.0.2:53550", "--messaging", "--history-retention-days", "30"]

describe("running the setup twice", () => {
    it("changes nothing the second time, with or without --force", async () => {
        expect((await cli(BASE)).code).toBe(0)
        const first = snapshot()
        expect((await cli(BASE)).code).toBe(0)
        expect(snapshot()).toEqual(first)
        expect((await cli([...BASE, "--force"])).code).toBe(0)
        expect(snapshot()).toEqual(first)
        expect((await cli([...BASE, "--force"])).code).toBe(0)
        expect(snapshot()).toEqual(first)
    })

    it("does not rotate the key on --force unless a new key is given", async () => {
        await cli(BASE)
        const key = read(sub("s1", "private_key.txt"))
        const iv = read(sub("s1", "iv.txt"))
        await cli([...BASE, "--force"])
        expect(read(sub("s1", "private_key.txt"))).toBe(key)
        expect(read(sub("s1", "iv.txt"))).toBe(iv)
    })

    it("a different subnet id adds a second subnet and leaves the first alone", async () => {
        await cli(BASE)
        const before = snapshot()
        await cli(["--yes", "--l2ps-uid", "s2"])
        const after = snapshot()
        for (const [file, content] of Object.entries(before)) {
            if (file !== ".env") expect(after[file]).toBe(content)
        }
        expect(fs.existsSync(sub("s2", "config.json"))).toBe(true)
    })

    it("keeps fields it does not manage when it repairs a config", async () => {
        const dir = writeSubnet(root, "s1", { key: null })
        const cfg = JSON.parse(read(path.join(dir, "config.json")))
        cfg.name = "Operator label"
        cfg.config.network_params = { max_tx_per_block: 7 }
        fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg))
        await cli(["--yes", "--l2ps-uid", "s1"])
        const after = JSON.parse(read(path.join(dir, "config.json")))
        expect(after.name).toBe("Operator label")
        expect(after.config.network_params).toEqual({ max_tx_per_block: 7 })
    })
})

describe("partial state", () => {
    it("keys present but no config.json and no .env: the keys are reused, not regenerated", async () => {
        const dir = path.join(root, "data/l2ps/s1")
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, "private_key.txt"), HEX_KEY)
        fs.writeFileSync(path.join(dir, "iv.txt"), HEX_IV)
        const { code } = await cli(BASE)
        expect(code).toBe(0)
        expect(read(path.join(dir, "private_key.txt")).trim()).toBe(HEX_KEY)
        expect(read(path.join(dir, "iv.txt")).trim()).toBe(HEX_IV)
        expect(fs.readdirSync(dir).filter(f => f.includes(".bak"))).toEqual([])
    })

    it("a missing IV is rebuilt, and the operator is told it is a new one", async () => {
        writeSubnet(root, "s1", { iv: null })
        const { code, out } = await cli(["--yes", "--l2ps-uid", "s1"])
        expect(code).toBe(0)
        expect(read(sub("s1", "private_key.txt")).trim()).toBe(HEX_KEY)
        expect(read(sub("s1", "iv.txt")).trim()).not.toBe("")
        expect(out).toMatch(/new (random )?IV/i)
        expect(out).toContain("owner")
    })

    it("a missing key is rebuilt, and the operator is told it is a new one", async () => {
        writeSubnet(root, "s1", { key: null })
        const { out } = await cli(["--yes", "--l2ps-uid", "s1"])
        expect(out).toMatch(/new (random )?key/i)
    })

    it("a corrupt key or IV is refused without --force and replaced, with a backup, with it", async () => {
        for (const which of ["private_key.txt", "iv.txt"]) {
            const uid = which.startsWith("p") ? "k1" : "i1"
            writeSubnet(root, uid, which.startsWith("p") ? { key: "zz-corrupt" } : { iv: "zz-corrupt" })
            const before = snapshot()
            const refused = await cli(["--yes", "--l2ps-uid", uid])
            expect(refused.code).toBe(1)
            expect(snapshot()).toEqual(before)
            const forced = await cli(["--yes", "--force", "--l2ps-uid", uid])
            expect(forced.code).toBe(0)
            const backups = fs.readdirSync(path.join(root, "data/l2ps", uid)).filter(f => f.startsWith(`${which}.bak-`))
            expect(backups).toHaveLength(1)
            expect(read(path.join(root, "data/l2ps", uid, backups[0])).trim()).toBe("zz-corrupt")
            expect(read(sub(uid, which))).toMatch(/^[0-9a-f]+\n$/)
        }
    })

    it("a refused key changes nothing else, even when the config differs too", async () => {
        writeSubnet(root, "s1")
        const before = snapshot()
        const other = "11".repeat(32)
        const { code } = await cli(["--yes", "--l2ps-uid", "s1", "--l2ps-rpc", "http://other:1", "--l2ps-role", "join"], {
            DEMOS_SETUP_L2PS_KEY: other,
            DEMOS_SETUP_L2PS_IV: HEX_IV,
        })
        expect(code).toBe(1)
        expect(snapshot()).toEqual(before)
    })

    it("a truncated, empty or whitespace-only key file counts as corrupt", async () => {
        for (const [i, bad] of ["", "   \n", "abc", "0x"].entries()) {
            const uid = `t${i}`
            writeSubnet(root, uid, { key: bad })
            const before = snapshot()
            expect((await cli(["--yes", "--l2ps-uid", uid])).code).toBe(1)
            expect(snapshot()).toEqual(before)
        }
    })

    it(".env present but the keys missing: the keys are made, the .env entries are kept", async () => {
        fs.writeFileSync(path.join(root, ".env"), "# mine\nL2PS_MESSAGING_ENABLED=true\nL2PS_MESSAGING_PORT=3100\n")
        const { code } = await cli(["--yes", "--l2ps-uid", "s1", "--messaging", "--messaging-port", "3100"])
        expect(code).toBe(0)
        expect(read(path.join(root, ".env"))).toBe("# mine\nL2PS_MESSAGING_ENABLED=true\nL2PS_MESSAGING_PORT=3100\n")
        expect(fs.existsSync(sub("s1", "private_key.txt"))).toBe(true)
    })
})

describe("the order files are written in", () => {
    it("puts both key files down before config.json when a subnet is created", async () => {
        const real = fs.renameSync
        const landed: string[] = []
        const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
            landed.push(path.basename(String(to)))
            return real(from, to)
        }) as typeof fs.renameSync)
        try {
            expect((await cli(["--yes", "--only", "l2ps", "--l2ps-uid", "ordered"])).code).toBe(0)
        } finally {
            spy.mockRestore()
        }
        const files = landed.filter(f => ["private_key.txt", "iv.txt", "config.json"].includes(f))
        expect(files).toHaveLength(3)
        expect(files[files.length - 1]).toBe("config.json")
        expect(new Set(files.slice(0, 2))).toEqual(new Set(["private_key.txt", "iv.txt"]))
    })

    it("also when an existing subnet is repaired: the replaced key lands before the config that names it", async () => {
        writeSubnet(root, "fix", { key: "zz-corrupt" })
        const real = fs.renameSync
        const landed: string[] = []
        const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
            landed.push(path.basename(String(to)))
            return real(from, to)
        }) as typeof fs.renameSync)
        try {
            await cli(["--yes", "--only", "l2ps", "--l2ps-uid", "fix", "--l2ps-rpc", "http://other:1", "--force"])
        } finally {
            spy.mockRestore()
        }
        expect(landed.indexOf("private_key.txt")).toBeGreaterThanOrEqual(0)
        expect(landed.indexOf("private_key.txt")).toBeLessThan(landed.indexOf("config.json"))
    })
})

describe("the warning about a regenerated key or IV", () => {
    it("is shown for each missing half and names the file", async () => {
        writeSubnet(root, "no_iv", { iv: null })
        writeSubnet(root, "no_key", { key: null })
        const a = await cli(["--yes", "--only", "l2ps", "--l2ps-uid", "no_iv"])
        expect(a.out).toMatch(/Warning: data\/l2ps\/no_iv\/iv\.txt was missing or unusable, so a new random IV/)
        const b = await cli(["--yes", "--only", "l2ps", "--l2ps-uid", "no_key"])
        expect(b.out).toMatch(/Warning: data\/l2ps\/no_key\/private_key\.txt was missing or unusable, so a new random key/)
        expect(b.out).toContain("original key from its owner")
    })

    it("is also part of a dry run, which writes nothing", async () => {
        writeSubnet(root, "no_iv", { iv: null })
        const before = snapshot()
        const { out } = await cli(["--yes", "--dry-run", "--only", "l2ps", "--l2ps-uid", "no_iv"])
        expect(out).toContain("new random IV")
        expect(snapshot()).toEqual(before)
    })

    it("is not shown for a brand new subnet, for a healthy one, or when the missing half is imported", async () => {
        const fresh = await cli(["--yes", "--only", "l2ps", "--l2ps-uid", "fresh"])
        expect(fresh.out).not.toContain("Warning")
        const again = await cli(["--yes", "--only", "l2ps", "--l2ps-uid", "fresh"])
        expect(again.out).not.toContain("new random")
        writeSubnet(root, "imp", { iv: null })
        const imported = await cli(["--yes", "--only", "l2ps", "--l2ps-uid", "imp", "--l2ps-role", "join"], { DEMOS_SETUP_L2PS_KEY: HEX_KEY, DEMOS_SETUP_L2PS_IV: HEX_IV })
        expect(imported.out).not.toContain("new random")
        expect(read(sub("imp", "iv.txt")).trim()).toBe(HEX_IV)
    })
})

describe("a write that fails halfway", () => {
    it("leaves no config.json pointing at keys that were never written", async () => {
        const dir = path.join(root, "data/l2ps/s1")
        fs.mkdirSync(path.join(dir, "iv.txt"), { recursive: true })
        const { code, out } = await cli(["--yes", "--l2ps-uid", "s1"])
        expect(code).toBe(1)
        expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false)
        expect(fs.readdirSync(dir).filter(f => f.includes(".tmp-"))).toEqual([])
        expect(out).toContain("iv.txt")
    })

    it("reports a file that is a directory as a problem, not as a stack trace", async () => {
        const dir = writeSubnet(root, "s1", { key: null })
        fs.mkdirSync(path.join(dir, "private_key.txt"))
        const { code, out } = await cli(["--yes", "--l2ps-uid", "s1"])
        expect(code).toBe(1)
        expect(out).toContain("private_key.txt")
        expect(out).not.toMatch(/\n\s+at /)
    })

    it.skipIf(isRoot)(`reports an unwritable subnet directory as a problem and writes nothing ${AS_USER}`, async () => {
        const base = path.join(root, "data/l2ps")
        fs.mkdirSync(base, { recursive: true })
        fs.chmodSync(base, 0o555)
        try {
            const { code, out } = await cli(["--yes", "--l2ps-uid", "s1"])
            expect(code).toBe(1)
            expect(out).toContain("s1")
            expect(fs.readdirSync(base)).toEqual([])
        } finally {
            fs.chmodSync(base, 0o755)
        }
    })
})

describe("where files are written", () => {
    let outside: string
    beforeEach(() => {
        outside = fs.mkdtempSync(path.join(os.tmpdir(), "demos-outside-"))
    })
    afterEach(() => fs.rmSync(outside, { recursive: true, force: true }))

    it("never writes where a config.json points outside the node directory", async () => {
        const sibling = `${root}-evil`
        fs.mkdirSync(sibling)
        try {
            for (const [uid, keyPath, ivPath] of [
                ["abs", path.join(outside, "k.txt"), path.join(outside, "iv.txt")],
                ["up", "../../../../../../../../tmp/zz-outside-k", "data/l2ps/up/iv.txt"],
                ["sib", `../${path.basename(sibling)}/k.txt`, "data/l2ps/sib/iv.txt"],
            ]) {
                writeSubnet(root, uid, {
                    key: null,
                    iv: null,
                    config: { uid, enabled: true, config: { known_rpcs: ["http://a:1"] }, keys: { private_key_path: keyPath, iv_path: ivPath } },
                })
                for (const force of [false, true]) {
                    await cli(["--yes", "--l2ps-uid", uid, ...(force ? ["--force"] : [])])
                }
            }
            expect(fs.readdirSync(outside)).toEqual([])
            expect(fs.readdirSync(sibling)).toEqual([])
            expect(fs.existsSync("/tmp/zz-outside-k")).toBe(false)
        } finally {
            fs.rmSync(sibling, { recursive: true, force: true })
        }
    })

    it("a refused outside path ends in a non-zero exit and names the problem", async () => {
        writeSubnet(root, "abs", {
            key: null,
            iv: null,
            config: { uid: "abs", enabled: true, config: { known_rpcs: ["http://a:1"] }, keys: { private_key_path: path.join(outside, "k"), iv_path: path.join(outside, "i") } },
        })
        const { code, out } = await cli(["--yes", "--l2ps-uid", "abs"])
        expect(code).toBe(1)
        expect(out).toContain("outside the node directory")
    })

    it("does not write through a symlinked key file; --force replaces the link and keeps a backup", async () => {
        writeSubnet(root, "s1", { key: null })
        const target = path.join(outside, "k")
        fs.writeFileSync(target, HEX_KEY + "\n")
        fs.symlinkSync(target, sub("s1", "private_key.txt"))
        const fresh = "11".repeat(32)
        const run = await cli(["--yes", "--force", "--l2ps-uid", "s1", "--l2ps-role", "join"], { DEMOS_SETUP_L2PS_KEY: fresh, DEMOS_SETUP_L2PS_IV: HEX_IV })
        expect(run.code).toBe(0)
        expect(read(target)).toBe(HEX_KEY + "\n")
        expect(fs.lstatSync(sub("s1", "private_key.txt")).isSymbolicLink()).toBe(false)
        expect(read(sub("s1", "private_key.txt")).trim()).toBe(fresh)
    })

    it("fixes the mode of a key file that is world readable, never the other way", async () => {
        writeSubnet(root, "s1")
        fs.chmodSync(sub("s1", "private_key.txt"), 0o644)
        fs.chmodSync(sub("s1", "iv.txt"), 0o400)
        await cli(["--yes", "--l2ps-uid", "s1"])
        expect(fs.statSync(sub("s1", "private_key.txt")).mode & 0o777).toBe(0o600 & 0o644)
        expect(fs.statSync(sub("s1", "iv.txt")).mode & 0o777).toBe(0o400)
    })

    it("honours a custom key location inside the node directory and keeps using it", async () => {
        writeSubnet(root, "s1", {
            key: null,
            iv: null,
            config: { uid: "s1", enabled: true, config: { known_rpcs: ["http://a:1"] }, keys: { private_key_path: "secrets/s1.key", iv_path: "secrets/s1.iv" } },
        })
        await cli(["--yes", "--l2ps-uid", "s1"])
        const firstKey = read(path.join(root, "secrets/s1.key"))
        expect(fs.existsSync(sub("s1", "private_key.txt"))).toBe(false)
        await cli(["--yes", "--l2ps-uid", "s1"])
        expect(read(path.join(root, "secrets/s1.key"))).toBe(firstKey)
    })
})
