import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { inspectSubnet } from "@/cli/setup/l2ps"

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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "demos-compat-"))
    process.chdir(tmp)
})
afterEach(() => {
    process.chdir(cwd)
    fs.rmSync(tmp, { recursive: true, force: true })
})

let seq = 0
function subnet(key: string, iv: string): string {
    const uid = `s${seq++}`
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
    return uid
}

// Each row is (key file text, IV file text). The checker must call a subnet
// usable exactly when the real loader loads it, including the odd inputs an
// operator's editor or a copy-paste can produce.
const CASES: Array<[string, string, string]> = [
    ["plain hex, no prefix (existing testnet configs)", KEY, IV],
    ["trailing newline", KEY + "\n", IV + "\n"],
    ["CRLF line ending", KEY + "\r\n", IV + "\r\n"],
    ["0x prefix", "0x" + KEY, "0x" + IV],
    ["0X prefix", "0X" + KEY, "0X" + IV],
    ["upper-case hex", KEY.toUpperCase(), IV.toUpperCase()],
    ["leading and trailing whitespace", `  \t${KEY}  \n\n`, `\n${IV}\n`],
    ["hex wrapped over several lines", `${KEY.slice(0, 32)}\n${KEY.slice(32)}\n`, IV],
    ["byte order mark in front", "\uFEFF" + KEY, "\uFEFF" + IV],
    ["0x after whitespace", `  0x${KEY}`, IV],
    ["odd-length key", KEY + "a", IV],
    ["odd-length IV", KEY, IV.slice(1)],
    ["non-hex key", "zz" + KEY.slice(2), IV],
    ["non-hex IV", KEY, "g" + IV.slice(1)],
    ["empty key", "", IV],
    ["whitespace-only key", " \n\t ", IV],
    ["bare 0x", "0x", IV],
    ["0x twice", "0x0x" + KEY, IV],
    ["internal 0x", KEY.slice(0, 32) + "0x" + KEY.slice(32), IV],
    ["comment-looking text", "# key\n" + KEY, IV],
    ["2-byte key", "abcd", IV],
    ["31-byte key", KEY.slice(2), IV],
    ["33-byte key", KEY + "ab", IV],
    ["16-byte key and 12-byte IV", "ab".repeat(16), "cd".repeat(12)],
    ["24-byte key", "ab".repeat(24), IV],
    ["8-byte IV", KEY, "cd".repeat(8)],
    ["64-byte IV", KEY, "cd".repeat(64)],
]

async function loads(uid: string): Promise<boolean> {
    try {
        await parallelNetworks.getInstance().loadL2PS(uid)
        return true
    } catch {
        return false
    }
}

describe("checker and loader agree on key files", () => {
    for (const [name, key, iv] of CASES) {
        it(name, async () => {
            const uid = subnet(key, iv)
            const loaded = await loads(uid)
            const status = inspectSubnet(tmp, uid)
            // A warning is fine for the checker; "ok" must mean the loader
            // takes it, and anything else must mean the loader refuses it.
            expect(status.state === "ok").toBe(loaded)
        })
    }
})

function withConfig(config: unknown, dirName = `c${seq++}`): string {
    const dir = path.join(tmp, "data", "l2ps", dirName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "private_key.txt"), KEY)
    fs.writeFileSync(path.join(dir, "iv.txt"), IV)
    fs.writeFileSync(
        path.join(dir, "config.json"),
        typeof config === "string" ? config : JSON.stringify(config),
    )
    return dirName
}

const keys = (uid: string) => ({
    private_key_path: `data/l2ps/${uid}/private_key.txt`,
    iv_path: `data/l2ps/${uid}/iv.txt`,
})

describe("checker and loader agree on config.json shapes", () => {
    const shapes: Array<[string, (uid: string) => unknown]> = [
        ["a complete config", uid => ({ uid, enabled: true, config: {}, keys: keys(uid) })],
        ["no uid field", uid => ({ enabled: true, config: {}, keys: keys(uid) })],
        ["uid field that differs from the directory", uid => ({ uid: "other", enabled: true, config: {}, keys: keys(uid) })],
        ["enabled false", uid => ({ uid, enabled: false, config: {}, keys: keys(uid) })],
        ["enabled as the string \"false\"", uid => ({ uid, enabled: "false", config: {}, keys: keys(uid) })],
        ["enabled missing", uid => ({ uid, config: {}, keys: keys(uid) })],
        ["no keys block", uid => ({ uid, enabled: true, config: {} })],
        ["empty key path", uid => ({ uid, enabled: true, config: {}, keys: { ...keys(uid), private_key_path: "" } })],
        ["key path that is not a string", uid => ({ uid, enabled: true, config: {}, keys: { ...keys(uid), private_key_path: 5 } })],
        ["key path escaping the checkout", uid => ({ uid, enabled: true, config: {}, keys: { ...keys(uid), private_key_path: "../../../etc/hostname" } })],
        ["absolute key path outside the checkout", uid => ({ uid, enabled: true, config: {}, keys: { ...keys(uid), iv_path: "/etc/hostname" } })],
        ["key path with .. that stays inside", uid => ({ uid, enabled: true, config: {}, keys: { ...keys(uid), private_key_path: `data/l2ps/${uid}/../${uid}/private_key.txt` } })],
        ["JSON null", () => "null"],
        ["JSON array", () => "[]"],
        ["JSON number", () => "7"],
        ["truncated JSON", () => "{\"uid\": \"x\", \"enabled\": tr"],
        ["empty file", () => ""],
    ]
    for (const [name, make] of shapes) {
        it(name, async () => {
            const uid = `c${seq++}`
            withConfig(make(uid), uid)
            const loaded = await loads(uid)
            const status = inspectSubnet(tmp, uid)
            expect(status.state === "ok").toBe(loaded)
        })
    }
})
