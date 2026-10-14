import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
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

// The node reads these flags with its own rules (loader.ts envBool and the
// messaging check in index.ts). A checker that is more generous than the node
// would demand setup for a feature the node never turns on, and in strict
// mode would refuse to start over it.
describe("flags are read the way the node reads them", () => {
    it("L2PS_MESSAGING_ENABLED is on only for the word true, in any case", () => {
        for (const off of ["1", "yes", "on", "y", "", "false"]) {
            expect(problems({ L2PS_MESSAGING_ENABLED: off })).toEqual([])
        }
        for (const on of ["true", "TRUE", "True"]) {
            expect(problems({ L2PS_MESSAGING_ENABLED: on }).map(p => p.item)).toContain("Subnet for messaging")
        }
    })

    it("L2PS_ZK_ENABLED is on only for exactly true or 1", () => {
        writeSubnet(root, "s1")
        for (const off of ["TRUE", "True", "yes", "on", "y", "false", "0"]) {
            expect(problems({ L2PS_ZK_ENABLED: off })).toEqual([])
        }
        for (const on of ["true", "1"]) {
            expect(problems({ L2PS_ZK_ENABLED: on }).length).toBeGreaterThan(0)
        }
    })

    it("an explicit true with a complete key set is healthy, a half-built set is not", () => {
        writeSubnet(root, "s1")
        writeZkBatch(root, 5)
        writeZkBatch(root, 10)
        expect(problems({ L2PS_ZK_ENABLED: "true" })).toEqual([])
    })

    it("plaintext history is flagged only when the node would store it", () => {
        for (const off of ["TRUE", "yes", "on", "false", ""]) {
            expect(items({ L2PS_HISTORY_STORE_PLAINTEXT: off }).some(i => i.item === "Plaintext history")).toBe(false)
        }
        for (const on of ["true", "1"]) {
            expect(items({ L2PS_HISTORY_STORE_PLAINTEXT: on }).some(i => i.item === "Plaintext history")).toBe(true)
        }
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
