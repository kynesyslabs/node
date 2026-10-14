import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { loadConfig } from "../../config/loader"
import { parseMessagingEnabled, parseMessagingPort } from "../../config/envFlags"
import { collectChecks, isProblem } from "./checks"
import { createContext } from "./context"
import { makeRoot, removeRoot, writeSubnet, writeZkBatch } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

const problems = (env: Record<string, string>) =>
    collectChecks(createContext(root, ".env", env, false)).items.filter(isProblem)
const items = (env: Record<string, string>) => collectChecks(createContext(root, ".env", env, false)).items

// The node and the checker must read every setting the same way. The node side
// is the real loader (loadConfig) and the shared helpers index.ts imports; the
// checker side is collectChecks. Both get the same raw strings, including the
// ones nobody would write on purpose.
const RAW = ["true", "TRUE", "True", "1", "0", "false", "FALSE", "yes", "no", "on", "off", "y", "2", " true", "true ", "-1", "30", "030", "30days", "3.7", "1e3", "0x10", "abc", " ", "9999999999999999999999"]

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
    for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
    try {
        return fn()
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    }
}

describe("the checker reads settings exactly as the node does", () => {
    it("L2PS_ZK_ENABLED: proofs are required by the checker iff the loader turns them on", () => {
        writeSubnet(root, "s1")
        for (const raw of RAW.filter(r => r !== " ")) {
            const node = withEnv({ L2PS_ZK_ENABLED: raw }, () => loadConfig().l2ps.zkEnabled)
            expect([raw, problems({ L2PS_ZK_ENABLED: raw }).length > 0]).toEqual([raw, node])
        }
    })

    it("L2PS_HISTORY_STORE_PLAINTEXT: the plaintext warning appears iff the loader stores plaintext", () => {
        for (const raw of RAW) {
            const node = withEnv({ L2PS_HISTORY_STORE_PLAINTEXT: raw }, () => loadConfig().l2ps.historyStorePlaintext)
            const warned = items({ L2PS_HISTORY_STORE_PLAINTEXT: raw }).some(i => i.item === "Plaintext history")
            expect([raw, warned]).toEqual([raw, node])
        }
    })

    it("L2PS_MESSAGING_ENABLED: a missing subnet is reported iff the node would start messaging", () => {
        for (const raw of RAW) {
            const node = parseMessagingEnabled(raw)
            const reported = problems({ L2PS_MESSAGING_ENABLED: raw }).some(p => p.item === "Subnet for messaging")
            expect([raw, reported]).toEqual([raw, node])
        }
    })

    it("L2PS_MESSAGING_PORT: the checker names the port the node will bind", () => {
        for (const raw of RAW) {
            const node = parseMessagingPort(raw)
            const item = items({ L2PS_MESSAGING_ENABLED: "true", L2PS_MESSAGING_PORT: raw }).find(i => i.item === "Port")
            expect(item).toBeDefined()
            if (node.source === "invalid") {
                expect([raw, item?.status]).toEqual([raw, "invalid"])
                expect(item?.detail).toContain(String(node.port))
            } else if (node.source === "env") {
                expect(item?.detail).toContain(String(node.port))
            }
        }
    })

    it("L2PS_HISTORY_RETENTION_DAYS: the number in the report is the one the loader uses", () => {
        for (const raw of RAW) {
            const node = withEnv({ L2PS_HISTORY_RETENTION_DAYS: raw }, () => loadConfig().l2ps.historyRetentionDays)
            const item = items({ L2PS_HISTORY_RETENTION_DAYS: raw }).find(i => i.item === "History retention")
            expect(item).toBeDefined()
            const detail = item?.detail ?? ""
            if (item?.status === "ok") {
                expect([raw, detail]).toEqual([raw, node === 0 ? "keeps history forever" : `${node} days`])
            } else if (detail.includes("not a number")) {
                // The loader falls back to its default, which keeps history.
                expect([raw, node]).toEqual([raw, 0])
            } else {
                expect([raw, detail]).toEqual([raw, expect.stringContaining(String(node))])
            }
        }
    })

    it("only calls a retention value out when the node reads it differently from plain digits", () => {
        const status = (raw: string) => items({ L2PS_HISTORY_RETENTION_DAYS: raw }).find(i => i.item === "History retention")?.status
        expect(["0", "30", "030", "36500", "1000000"].map(status)).toEqual(["ok", "ok", "ok", "ok", "ok"])
        expect(["30days", "3.7", "1e3", "0x10"].map(status)).toEqual(["warn", "warn", "warn", "warn"])
        expect(["abc", "-1", "-30"].map(status)).toEqual(["invalid", "invalid", "invalid"])
    })

    it("the node's entry points all use the shared helpers, not their own copies", () => {
        const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dir, "../../..", rel), "utf8")
        expect(read("src/index.ts")).toContain("config/envFlags")
        expect(read("src/index.ts")).not.toMatch(/L2PS_MESSAGING_ENABLED\??\.toLowerCase/)
        expect(read("src/features/l2ps-messaging/index.ts")).toContain("config/envFlags")
        expect(read("src/features/l2ps-messaging/index.ts")).not.toContain("toLowerCase() === \"true\"")
        const loader = read("src/config/loader.ts")
        expect(loader).toContain("./envFlags")
        expect(loader).not.toContain("raw === \"true\" || raw === \"1\"")
    })
})

describe("the port message matches what the node really does", () => {
    it("never claims a fallback for a value the node reads fine", () => {
        // parseInt reads 3100 out of "3100abc", so the node does not fall back.
        const port = items({ L2PS_MESSAGING_ENABLED: "true", L2PS_MESSAGING_PORT: "3100abc" }).find(i => i.item === "Port")
        expect(port?.detail ?? "").not.toContain("falls back")
        expect(port?.detail).toContain("3100")
        expect(port?.status).toBe("warn")
    })

    it("flags a value the node cannot use and names the fallback", () => {
        for (const bad of ["0", "70000", "abc", "-1", "0x1F90"]) {
            const port = items({ L2PS_MESSAGING_ENABLED: "true", L2PS_MESSAGING_PORT: bad }).find(i => i.item === "Port")
            expect(port?.status).toBe("invalid")
            expect(port?.detail).toContain("3006")
        }
    })
})

describe("key files that would not survive", () => {
    it("warns about a key inside node_modules, which a reinstall wipes", () => {
        writeSubnet(root, "nm", {
            config: { uid: "nm", enabled: true, config: { known_rpcs: [] }, keys: { private_key_path: "node_modules/x/k.txt", iv_path: "node_modules/x/iv.txt" } },
            key: null,
            iv: null,
        })
        const dir = `${root}/node_modules/x`
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(`${dir}/k.txt`, "ab".repeat(32))
        fs.writeFileSync(`${dir}/iv.txt`, "cd".repeat(16))
        const subnet = items({}).find(i => i.item === "Subnet nm")
        expect(subnet?.status).toBe("warn")
        expect(subnet?.detail).toContain("reinstalled")
    })
})
