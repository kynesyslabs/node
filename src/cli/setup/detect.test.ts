import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { collectChecks, fixesFor, isProblem, renderTable } from "./checks"
import { createContext } from "./context"
import { inspectSubnet, inspectSubnets } from "./l2ps"
import { inspectBatchArtifacts, inspectIdentityKey } from "./zk"
import { makeRoot, removeRoot, writeSubnet, writeZkBatch, HEX_KEY } from "./testSupport"

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
        expect(s.problems.join()).toContain("cannot be read")

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
