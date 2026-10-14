import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// The loader only needs the SDK cipher; the shared state, logger and signing
// pool are irrelevant to key parsing and would pull in the whole node.
mock.module("@/utilities/sharedState", () => ({ getSharedState: {} }))
mock.module("@/utilities/logger", () => ({
    default: new Proxy({}, { get: () => () => undefined }),
}))
mock.module("../blockchain/validation/txValidatorPool", () => ({
    default: { getInstance: () => ({}) },
}))

const { default: parallelNetworks } = await import("./parallelNetworks")

const KEY = "ab".repeat(32)
const IV = "cd".repeat(16)

let cwd: string
let tmp: string
beforeEach(() => {
    cwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "demos-loader-"))
    process.chdir(tmp)
})
afterEach(() => {
    process.chdir(cwd)
    fs.rmSync(tmp, { recursive: true, force: true })
})

function subnet(uid: string, key: string, iv: string) {
    const dir = path.join(tmp, "data", "l2ps", uid)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "private_key.txt"), key)
    fs.writeFileSync(path.join(dir, "iv.txt"), iv)
    fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
            uid,
            enabled: true,
            config: { created_at_block: 0, known_rpcs: [] },
            keys: {
                private_key_path: `data/l2ps/${uid}/private_key.txt`,
                iv_path: `data/l2ps/${uid}/iv.txt`,
            },
        }),
    )
}

describe("ParallelNetworks key files", () => {
    it("accepts a 0x prefix in either case", async () => {
        subnet("lower", "0x" + KEY, IV)
        subnet("upper", "0X" + KEY + "\n", "0X" + IV)
        const nets = parallelNetworks.getInstance()
        expect(await nets.loadL2PS("lower")).toBeDefined()
        expect(await nets.loadL2PS("upper")).toBeDefined()
    })

    it("still rejects non-hex content", async () => {
        subnet("bad", "0Xzz" + KEY, IV)
        await expect(parallelNetworks.getInstance().loadL2PS("bad")).rejects.toThrow("non-hex")
    })
})
