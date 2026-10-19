import { afterAll, beforeAll, describe, expect, it, mock, setDefaultTimeout } from "bun:test"
import dotenv from "dotenv"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { runCli } from "./cli"
import { inspectSubnet } from "./l2ps"
import { enforceGuidedSetup, type GateDeps } from "./startupGate"
import { fakeRunner, makeRoot, recorder, removeRoot } from "./testSupport"
import { byCodePoint } from "./zk"

mock.module("@/utilities/sharedState", () => ({ getSharedState: {} }))
mock.module("@/utilities/logger", () => ({
    default: new Proxy({}, { get: () => () => undefined }),
}))
mock.module("@/libs/blockchain/validation/txValidatorPool", () => ({
    default: { getInstance: () => ({}) },
}))
mock.module("../../libs/blockchain/validation/txValidatorPool", () => ({
    default: { getInstance: () => ({}) },
}))
const { default: parallelNetworks } = await import("../../libs/l2ps/parallelNetworks")

setDefaultTimeout(120_000)

const repo = path.resolve(import.meta.dir, "../../..")
const KEY = "9a".repeat(32)
const IV = "5c".repeat(16)

let copy: string
let startCwd: string

function copyFile(rel: string) {
    fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true })
    fs.copyFileSync(path.join(repo, rel), path.join(copy, rel))
}

/** A throwaway checkout: the setup code, the committed keys, nothing else. */
beforeAll(() => {
    startCwd = process.cwd()
    copy = fs.mkdtempSync(path.join(os.tmpdir(), "demos-e2e-"))
    for (const f of fs.readdirSync(path.join(repo, "src/cli/setup"))) {
        if (f.endsWith(".ts") && !f.includes(".test.") && f !== "gateHarness.ts") copyFile(`src/cli/setup/${f}`)
    }
    for (const rel of [
        "package.json",
        "src/config/envKeys.ts",
        "src/config/envFlags.ts",
        "src/libs/l2ps/zk/batchArtifacts.ts",
        "src/features/zk/keys/verification_key_merkle.json",
        "src/libs/l2ps/zk/keys/batch_5/verification_key.json",
        "src/libs/l2ps/zk/keys/batch_10/verification_key.json",
    ]) {
        copyFile(rel)
    }
    // A finished ZK build, so the run enables proofs without downloading anything.
    for (const size of [5, 10]) {
        const dir = path.join(copy, "src/libs/l2ps/zk/keys", `batch_${size}`)
        fs.mkdirSync(path.join(dir, `l2ps_batch_${size}_js`), { recursive: true })
        fs.writeFileSync(path.join(dir, `l2ps_batch_${size}.zkey`), "zkey")
        fs.writeFileSync(path.join(dir, `l2ps_batch_${size}_js`, `l2ps_batch_${size}.wasm`), "wasm")
    }
    fs.writeFileSync(path.join(copy, ".env"), "# operator file\nRPC_PORT=53550\nPG_PASSWORD=pa=ss#word\nexport EXPOSED_URL=http://203.0.113.9:53550\n")
})
afterAll(() => {
    process.chdir(startCwd)
    fs.rmSync(copy, { recursive: true, force: true })
})

function setup(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, ["run", "setup", ...args], {
        cwd: copy,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DEMOS_IN_DOCKER: "false", ...env },
    })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function snapshot(): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name)
            if (e.isDirectory()) walk(p)
            else out[path.relative(copy, p)] = `${fs.statSync(p).mode & 0o777}:${fs.readFileSync(p, "utf8")}`
        }
    }
    walk(copy)
    return out
}

const FULL_ENV = {
    DEMOS_SETUP_YES: "true",
    DEMOS_SETUP_L2PS_UID: "e2e_created",
    DEMOS_SETUP_L2PS_ROLE: "create",
    DEMOS_SETUP_L2PS_RPC: "http://203.0.113.9:53550, https://node2.example.org",
    DEMOS_SETUP_HISTORY_RETENTION_DAYS: "45",
    DEMOS_SETUP_HISTORY_STORE_PLAINTEXT: "false",
    DEMOS_SETUP_HISTORY_REQUIRE_V2: "true",
    DEMOS_SETUP_MESSAGING: "true",
    DEMOS_SETUP_MESSAGING_PORT: "3100",
    DEMOS_SETUP_ZK: "true",
}

describe("bun run setup --yes in a throwaway checkout", () => {
    it("runs end to end from DEMOS_SETUP_* alone and exits 0", () => {
        const r = setup([], FULL_ENV)
        expect([r.status, r.stdout.slice(-600), r.stderr.slice(-300)]).toEqual([0, expect.any(String), expect.any(String)])
        expect(r.stdout).toContain("Subnet e2e_created is ready")
        expect(r.stdout).not.toContain(KEY)
    })

    it("wrote the env entries without touching the operator's own lines", () => {
        const text = fs.readFileSync(path.join(copy, ".env"), "utf8")
        expect(text.startsWith("# operator file\nRPC_PORT=53550\nPG_PASSWORD=pa=ss#word\nexport EXPOSED_URL=http://203.0.113.9:53550\n")).toBe(true)
        expect(dotenv.parse(text)).toMatchObject({
            PG_PASSWORD: "pa=ss",
            EXPOSED_URL: "http://203.0.113.9:53550",
            L2PS_HISTORY_RETENTION_DAYS: "45",
            L2PS_HISTORY_STORE_PLAINTEXT: "false",
            L2PS_HISTORY_REQUIRE_V2: "true",
            L2PS_MESSAGING_ENABLED: "true",
            L2PS_MESSAGING_PORT: "3100",
            L2PS_ZK_ENABLED: "true",
        })
    })

    it("wrote key files with mode 600 and a config the loader's own shape expects", () => {
        const dir = path.join(copy, "data/l2ps/e2e_created")
        expect(fs.statSync(path.join(dir, "private_key.txt")).mode & 0o777).toBe(0o600)
        expect(fs.statSync(path.join(dir, "iv.txt")).mode & 0o777).toBe(0o600)
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))
        expect(cfg).toMatchObject({
            uid: "e2e_created",
            enabled: true,
            config: { known_rpcs: ["http://203.0.113.9:53550", "https://node2.example.org"] },
            keys: { private_key_path: "data/l2ps/e2e_created/private_key.txt", iv_path: "data/l2ps/e2e_created/iv.txt" },
        })
    })

    it("--check passes and --check --json is one valid document with ok true", () => {
        const plain = setup(["--check"])
        expect([plain.status, plain.stdout]).toEqual([0, expect.stringContaining("Nothing to fix")])
        const json = setup(["--check", "--json"])
        expect(json.status).toBe(0)
        const doc = JSON.parse(json.stdout) as { ok: boolean; items: Array<{ status: string }> }
        expect(doc.ok).toBe(true)
        expect(doc.items.filter(i => i.status === "missing" || i.status === "invalid")).toEqual([])
    })

    it("a second identical run changes nothing at all", () => {
        const before = snapshot()
        const r = setup([], FULL_ENV)
        expect(r.status).toBe(0)
        expect(snapshot()).toEqual(before)
    })

    it("joins a second subnet with an imported key and IV given through the environment only", () => {
        const r = setup([], { DEMOS_SETUP_YES: "true", DEMOS_SETUP_L2PS_UID: "e2e_joined", DEMOS_SETUP_L2PS_ROLE: "join", DEMOS_SETUP_L2PS_KEY: `0x${KEY}`, DEMOS_SETUP_L2PS_IV: IV.toUpperCase() })
        expect([r.status, r.stdout.slice(-400)]).toEqual([0, expect.any(String)])
        expect(r.stdout + r.stderr).not.toContain(KEY)
        expect(fs.readFileSync(path.join(copy, "data/l2ps/e2e_joined/private_key.txt"), "utf8").trim()).toBe(KEY)
        expect(fs.readFileSync(path.join(copy, "data/l2ps/e2e_joined/iv.txt"), "utf8").trim()).toBe(IV)
    })

    it("everything written parses through the real L2PS loader", async () => {
        process.chdir(copy)
        const nets = parallelNetworks.getInstance()
        const loaded = await nets.loadAllL2PS()
        expect(loaded.sort(byCodePoint)).toEqual(["e2e_created", "e2e_joined"])
        for (const uid of loaded) expect(await nets.loadL2PS(uid)).toBeDefined()
    })

    it("the start-up gate is silent on it, in strict mode too, and with the real .env", async () => {
        const lines: string[] = []
        const deps: Partial<GateDeps> = {
            cwd: copy,
            codeRoot: copy,
            env: { ...dotenv.parse(fs.readFileSync(path.join(copy, ".env"), "utf8")), DEMOS_SETUP_STRICT: "true" },
            interactive: false,
            inDocker: false,
            say: l => lines.push(l),
            logError: m => {
                lines.push(m)
            },
            strict: true,
            exit: ((code: number) => {
                throw new Error(`unexpected exit ${code}`)
            }) as GateDeps["exit"],
        }
        await enforceGuidedSetup(deps)
        expect(lines).toEqual([])
    })

    it("--help and a bad flag behave from the real command line", () => {
        const help = setup(["--help"])
        expect(help.status).toBe(0)
        expect(help.stdout).toContain("Exit codes")
        const bad = setup(["--check", "--json", "--nope"])
        expect(bad.status).toBe(2)
        expect(JSON.parse(bad.stdout).ok).toBe(false)
    })
})

describe("a config that already works elsewhere", () => {
    it("the devnet fixture is recognised as usable and a re-run leaves it byte for byte alone, even with --force", async () => {
        const root = makeRoot()
        try {
            const dest = path.join(root, "data/l2ps/live_local_001")
            fs.mkdirSync(dest, { recursive: true })
            for (const f of fs.readdirSync(path.join(repo, "testing/devnet/l2ps/live_local_001"))) {
                fs.copyFileSync(path.join(repo, "testing/devnet/l2ps/live_local_001", f), path.join(dest, f))
                fs.chmodSync(path.join(dest, f), f === "config.json" ? 0o644 : 0o600)
            }
            expect(inspectSubnet(root, "live_local_001").state).toBe("ok")
            const before = Object.fromEntries(fs.readdirSync(dest).map(f => [f, fs.readFileSync(path.join(dest, f), "utf8")]))
            for (const extra of [[], ["--force"]]) {
                const r = recorder()
                const code = await runCli(["--yes", "--only", "l2ps", "--l2ps-uid", "live_local_001", ...extra], {
                    cwd: root,
                    env: {},
                    isTTY: false,
                    say: r.say,
                    runner: fakeRunner(),
                    inDocker: false,
                })
                expect(code).toBe(0)
                expect(Object.fromEntries(fs.readdirSync(dest).map(f => [f, fs.readFileSync(path.join(dest, f), "utf8")]))).toEqual(before)
            }
        } finally {
            removeRoot(root)
        }
    })
})
