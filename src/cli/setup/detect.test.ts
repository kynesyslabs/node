import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { collectChecks, fixesFor, isProblem, renderTable } from "./checks"
import { createContext } from "./context"
import { inspectSubnet, inspectSubnets } from "./l2ps"
import { inspectBatchArtifacts, inspectIdentityKey } from "./zk"
import { describeProblems } from "./startupGate"
import { displaySafe } from "./validate"
import { findExecutable, makeRoot, removeRoot, writeSubnet, writeZkBatch, HEX_IV, HEX_KEY } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

const check = (env: Record<string, string> = {}) => collectChecks(createContext(root, ".env", env))
const find = (items: ReturnType<typeof check>["items"], re: RegExp) => items.find(i => re.test(`${i.area} ${i.item}`))

describe("subnet inspection", () => {
    it("treats a directory without config.json as a placeholder", () => {
        fs.mkdirSync(path.join(root, "data/l2ps/example"), { recursive: true })
        expect(inspectSubnets(root)[0].state).toBe("placeholder")
        expect(check().items.some(i => i.item.startsWith("Subnet example"))).toBe(false)
    })

    it("accepts a complete subnet", () => {
        writeSubnet(root, "good")
        expect(inspectSubnet(root, "good")).toMatchObject({ state: "ok", problems: [] })
    })

    it("reports missing key files", () => {
        writeSubnet(root, "nokey", { key: null })
        const s = inspectSubnet(root, "nokey")
        expect(s.state).toBe("missing-files")
        expect(s.problems.join()).toContain("private_key.txt is missing")
    })

    it("reports bad hex and unparsable config as invalid, exactly where the loader throws", () => {
        writeSubnet(root, "badhex", { key: "zz".repeat(32) })
        writeSubnet(root, "odd", { iv: "abc" })
        writeSubnet(root, "badjson", { config: "{nope" })
        expect(inspectSubnet(root, "badhex").state).toBe("invalid")
        expect(inspectSubnet(root, "odd").state).toBe("invalid")
        expect(inspectSubnet(root, "badjson").state).toBe("invalid")
    })

    it("accepts what the loader accepts: 0X prefix and whitespace inside the hex", () => {
        writeSubnet(root, "spaced", { key: "0X" + "ab".repeat(16) + "\n" + "ab".repeat(16) })
        expect(inspectSubnet(root, "spaced")).toMatchObject({ state: "ok", problems: [] })
    })

    it("treats key and IV lengths as warnings, because the loader does not check them", () => {
        writeSubnet(root, "short", { key: "ab".repeat(8), iv: "cd".repeat(5) })
        const s = inspectSubnet(root, "short")
        expect(s.state).toBe("ok")
        expect(s.warnings.join()).toContain("Key is 8 bytes")
        expect(s.warnings.join()).toContain("IV is 5 bytes")
        expect(check().items.filter(isProblem)).toEqual([])
    })

    it("treats a uid that differs from the directory as a warning and a path outside the node dir as a problem", () => {
        writeSubnet(root, "dirname", { config: { uid: "other", enabled: true, keys: { private_key_path: "data/l2ps/dirname/private_key.txt", iv_path: "data/l2ps/dirname/iv.txt" } } })
        writeSubnet(root, "escape", { config: { uid: "escape", enabled: true, keys: { private_key_path: "../../outside.txt", iv_path: "data/l2ps/escape/iv.txt" } } })
        const mismatch = inspectSubnet(root, "dirname")
        expect(mismatch.state).toBe("ok")
        expect(mismatch.warnings.join()).toContain("differs from the directory")
        expect(inspectSubnet(root, "escape").problems.join()).toContain("outside the node directory")
    })

    it("uses the loader's uid pattern for the directory name", () => {
        writeSubnet(root, "has.dot")
        expect(inspectSubnet(root, "has.dot").problems.join()).toContain("not a valid subnet id")
    })

    it("never throws on unreadable files: they become problems", () => {
        const dir = writeSubnet(root, "weird")
        fs.rmSync(path.join(dir, "private_key.txt"))
        fs.mkdirSync(path.join(dir, "private_key.txt"))
        const s = inspectSubnet(root, "weird")
        expect(s.state).toBe("invalid")
        expect(s.problems.join()).toContain("not a regular file")

        const locked = writeSubnet(root, "locked")
        fs.chmodSync(path.join(locked, "iv.txt"), 0o000)
        try {
            if (process.getuid?.() !== 0) {
                expect(inspectSubnet(root, "locked").problems.join()).toContain("cannot be read")
            }
            expect(() => check()).not.toThrow()
        } finally {
            fs.chmodSync(path.join(locked, "iv.txt"), 0o600)
        }

        // data/l2ps that is a file, not a directory
        const other = makeRoot()
        try {
            fs.mkdirSync(path.join(other, "data"), { recursive: true })
            fs.writeFileSync(path.join(other, "data/l2ps"), "x")
            const r = collectChecks(createContext(other, ".env", {}))
            expect(r.items.filter(isProblem).length).toBeGreaterThan(0)
        } finally {
            removeRoot(other)
        }
    })

    it("follows the key paths a config.json names", () => {
        const dir = writeSubnet(root, "custom", {
            config: {
                uid: "custom", enabled: true,
                keys: { private_key_path: "data/l2ps/custom/keys/k.txt", iv_path: "data/l2ps/custom/keys/i.txt" },
            },
            key: null, iv: null,
        })
        expect(inspectSubnet(root, "custom").state).toBe("missing-files")
        fs.mkdirSync(path.join(dir, "keys"))
        fs.writeFileSync(path.join(dir, "keys/k.txt"), "ab".repeat(32))
        fs.writeFileSync(path.join(dir, "keys/i.txt"), "cd".repeat(16))
        expect(inspectSubnet(root, "custom").state).toBe("ok")
    })

    it("does not count a disabled subnet as a problem", () => {
        writeSubnet(root, "off", { config: { uid: "off", enabled: false } })
        expect(inspectSubnet(root, "off").state).toBe("disabled")
        expect(check().items.filter(isProblem)).toEqual([])
    })

    it("warns when the key file is readable by others", () => {
        const dir = writeSubnet(root, "loose")
        fs.chmodSync(path.join(dir, "private_key.txt"), 0o644)
        expect(inspectSubnet(root, "loose").warnings.join()).toContain("chmod 600")
    })
})

describe("checks", () => {
    it("a plain node has nothing to fix and no L2PS", () => {
        const r = check()
        expect(r.items.filter(isProblem)).toEqual([])
        expect(find(r.items, /L2PS Subnet$/)?.status).toBe("off")
        expect(find(r.items, /ZK identity/)?.status).toBe("ok")
    })

    it("a broken subnet is a blocking problem with a fix command", () => {
        writeSubnet(root, "broken", { iv: null })
        const r = check()
        const problems = r.items.filter(isProblem)
        expect(problems).toHaveLength(1)
        expect(problems[0].status).toBe("missing")
        expect(fixesFor(problems)).toEqual(["bun run setup --only l2ps"])
    })

    it("messaging without a usable subnet is blocking, with one it is fine", () => {
        expect(check({ L2PS_MESSAGING_ENABLED: "true" }).items.filter(isProblem).map(i => i.item)).toEqual(["Subnet for messaging"])
        writeSubnet(root, "good")
        expect(check({ L2PS_MESSAGING_ENABLED: "true" }).items.filter(isProblem)).toEqual([])
    })

    it("an invalid messaging port is reported but does not block", () => {
        writeSubnet(root, "good")
        const port = find(check({ L2PS_MESSAGING_ENABLED: "true", L2PS_MESSAGING_PORT: "abc" }).items, /Port/)
        expect(port?.status).toBe("invalid")
        expect(port?.blocking).toBe(false)
    })

    it("ZK batch proofs are required only when explicitly enabled and a subnet exists", () => {
        // Unset: the code default only means "use keys if present".
        writeSubnet(root, "good")
        expect(check().items.filter(isProblem)).toEqual([])
        // Explicit off.
        expect(check({ L2PS_ZK_ENABLED: "false" }).items.filter(isProblem)).toEqual([])
        // Explicit on, nothing built.
        const on = check({ L2PS_ZK_ENABLED: "true" }).items.filter(isProblem)
        expect(on.length).toBeGreaterThan(0)
        expect(fixesFor(on)).toEqual(["bun run setup --only zk"])
        // Explicit on without any subnet: nothing to prove, not a problem.
        fs.rmSync(path.join(root, "data"), { recursive: true })
        expect(check({ L2PS_ZK_ENABLED: "true" }).items.filter(isProblem)).toEqual([])
    })

    it("needs the wasm as well as the zkey, and tolerates one missing batch size", () => {
        writeSubnet(root, "good")
        writeZkBatch(root, 5, { zkey: true, wasm: false, vkey: true })
        expect(check({ L2PS_ZK_ENABLED: "true" }).items.filter(isProblem).length).toBeGreaterThan(0)
        writeZkBatch(root, 5)
        const r = check({ L2PS_ZK_ENABLED: "true" })
        expect(r.items.filter(isProblem)).toEqual([])
        expect(find(r.items, /Batch of up to 10/)?.status).toBe("warn")
        writeZkBatch(root, 10)
        expect(inspectBatchArtifacts(root).every(b => b.complete)).toBe(true)
    })

    it("checks the identity verification key without ever offering to regenerate it", () => {
        fs.writeFileSync(path.join(root, "src/features/zk/keys/verification_key_merkle.json"), "{}")
        expect(inspectIdentityKey(root).state).toBe("invalid")
        fs.rmSync(path.join(root, "src/features/zk/keys/verification_key_merkle.json"))
        const item = find(check().items, /ZK identity/)
        expect(item?.status).toBe("missing")
        expect(item?.blocking).toBe(true)
        expect(item?.fatal).toBe(true)
        expect(item?.fix).toContain("restore the committed")
        expect(item?.fix).not.toContain("git checkout")
    })

    it("reads the env file as well as the process environment, process winning", () => {
        writeSubnet(root, "good")
        fs.writeFileSync(path.join(root, ".env"), "L2PS_ZK_ENABLED=true\n")
        expect(collectChecks(createContext(root, ".env", {})).items.filter(isProblem).length).toBeGreaterThan(0)
        expect(collectChecks(createContext(root, ".env", { L2PS_ZK_ENABLED: "false" })).items.filter(isProblem)).toEqual([])
    })

    it("renders a table with every status and never prints key material", () => {
        writeSubnet(root, "good")
        writeSubnet(root, "broken", { key: null })
        const table = renderTable(check().items)
        expect(table).toContain("Area")
        expect(table).toContain("configured")
        expect(table).toContain("MISSING")
        expect(table).not.toContain(HEX_KEY)
    })
})


describe("config-derived text is cleaned before it is shown", () => {
    const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

    it("strips escape sequences and control characters and caps the length", () => {
        expect(displaySafe("a\u001b[31mred\u001b[0m\nb")).toBe("ared b")
        expect(displaySafe("x\u001b]0;title\u0007y")).toBe("xy")
        expect(displaySafe("z".repeat(500)).length).toBeLessThanOrEqual(203)
    })

    it("a directory name with an escape sequence and a newline reaches neither the table nor the banner raw", () => {
        const evil = "bad\u001b[31m\nFORGED LINE"
        writeSubnet(root, evil, { key: null })
        const items = check().items
        const banner = describeProblems(items.filter(isProblem), false)
        for (const text of [renderTable(items), banner]) {
            expect(text.replace(/\n/g, "")).not.toMatch(CONTROL)
            expect(text).not.toContain("\u001b")
        }
        const bullets = banner.split("\n").filter(l => l.startsWith("   - "))
        expect(bullets.length).toBe(items.filter(isProblem).length)
        expect(banner.split("\n").some(l => l.startsWith("FORGED LINE"))).toBe(false)
    })

    it("a key path with an escape sequence and a newline is shown cleaned in the problem text", () => {
        writeSubnet(root, "p1", {
            key: null,
            iv: null,
            config: { uid: "p1", enabled: true, keys: { private_key_path: "data/l2ps/p1/k\u001b[31m\nEVIL.txt", iv_path: "data/l2ps/p1/iv\u001b[2J.txt" } },
        })
        const status = inspectSubnet(root, "p1")
        const text = [...status.problems, ...status.warnings].join("\n")
        expect(text).toContain("EVIL.txt")
        expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
        expect(text.split("\n").length).toBe(status.problems.length + status.warnings.length)
    })
})

describe("key and IV files are read only when they are plain files inside the node directory", () => {
    const withKeyPath = (uid: string, keyRel: string) =>
        writeSubnet(root, uid, {
            key: null,
            config: { uid, enabled: true, keys: { private_key_path: keyRel, iv_path: `data/l2ps/${uid}/iv.txt` } },
        })

    it("refuses a symbolic link, even to a good key inside the node directory", () => {
        const dir = withKeyPath("lnk", "data/l2ps/lnk/private_key.txt")
        fs.writeFileSync(path.join(root, "real.key"), HEX_KEY + "\n", { mode: 0o600 })
        fs.symlinkSync(path.join(root, "real.key"), path.join(dir, "private_key.txt"))
        const s = inspectSubnet(root, "lnk")
        expect(s.state).toBe("invalid")
        expect(s.problems.join()).toContain("symbolic link")
    })

    it("refuses a dangling symbolic link instead of calling it missing", () => {
        const dir = withKeyPath("dng", "data/l2ps/dng/private_key.txt")
        fs.symlinkSync(path.join(root, "nowhere"), path.join(dir, "private_key.txt"))
        expect(inspectSubnet(root, "dng").problems.join()).toContain("symbolic link")
    })

    const mkfifo = findExecutable("mkfifo")
    it.skipIf(mkfifo === undefined)("refuses a FIFO without blocking on it", () => {
        const dir = withKeyPath("fifo", "data/l2ps/fifo/private_key.txt")
        expect(spawnSync(mkfifo as string, [path.join(dir, "private_key.txt")]).status).toBe(0)
        const s = inspectSubnet(root, "fifo")
        expect(s.state).toBe("invalid")
        expect(s.problems.join()).toContain("not a regular file")
    })

    it("refuses a file larger than any key", () => {
        const dir = withKeyPath("big", "data/l2ps/big/private_key.txt")
        fs.writeFileSync(path.join(dir, "private_key.txt"), "a".repeat(64 * 1024 + 10), { mode: 0o600 })
        expect(inspectSubnet(root, "big").problems.join()).toContain("larger than")
    })

    it("treats a sibling directory that shares the node directory's name as outside it", () => {
        const sibling = `${root}-evil`
        fs.mkdirSync(sibling)
        try {
            fs.writeFileSync(path.join(sibling, "k.txt"), HEX_KEY + "\n", { mode: 0o600 })
            withKeyPath("sib", `../${path.basename(sibling)}/k.txt`)
            fs.writeFileSync(path.join(root, "data/l2ps/sib/iv.txt"), HEX_IV + "\n", { mode: 0o600 })
            const s = inspectSubnet(root, "sib")
            expect(s.state).toBe("invalid")
            expect(s.problems.join()).toContain("outside the node directory")
        } finally {
            fs.rmSync(sibling, { recursive: true, force: true })
        }
    })
})
