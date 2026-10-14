import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { runCli } from "./cli"
import { parseEnv } from "./envFile"
import { HEX_IV, HEX_KEY, fakeRunner, installZkTools, writeZkBatch, makeRoot, recorder, removeRoot, scriptedPrompter, writeSubnet } from "./testSupport"
import type { Prompter } from "./prompt"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

function cli(argv: string[], extra: { env?: Record<string, string>; isTTY?: boolean; prompter?: Prompter; runner?: ReturnType<typeof fakeRunner>; inDocker?: boolean } = {}) {
    const r = recorder()
    const run = runCli(argv, {
        cwd: root,
        env: extra.env ?? {},
        isTTY: extra.isTTY ?? false,
        say: r.say,
        prompter: extra.prompter,
        runner: extra.runner ?? fakeRunner(),
        inDocker: extra.inDocker ?? false,
    })
    return run.then(code => ({ code, out: r.text(), lines: r.lines }))
}

const subnetFile = (uid: string, f: string) => path.join(root, "data/l2ps", uid, f)
const envOf = () => parseEnv(fs.readFileSync(path.join(root, ".env"), "utf8"))

describe("non-interactive setup", () => {
    it("creates a subnet and the env entries from flags alone", async () => {
        const { code, out } = await cli([
            "--yes", "--l2ps-uid", "demo_1", "--l2ps-rpc", "http://10.0.0.2:53550",
            "--messaging", "--messaging-port", "3100", "--history-retention-days", "30",
        ])
        expect(code).toBe(0)
        expect(fs.statSync(subnetFile("demo_1", "private_key.txt")).mode & 0o777).toBe(0o600)
        expect(fs.statSync(subnetFile("demo_1", "iv.txt")).mode & 0o777).toBe(0o600)
        const cfg = JSON.parse(fs.readFileSync(subnetFile("demo_1", "config.json"), "utf8"))
        expect(cfg.config.known_rpcs).toEqual(["http://10.0.0.2:53550"])
        expect(envOf()).toMatchObject({
            L2PS_MESSAGING_ENABLED: "true",
            L2PS_MESSAGING_PORT: "3100",
            L2PS_HISTORY_RETENTION_DAYS: "30",
        })
        expect(out).toContain("Subnet demo_1 is ready")
        expect(out).toContain("configured")
        const key = fs.readFileSync(subnetFile("demo_1", "private_key.txt"), "utf8").trim()
        expect(out).not.toContain(key)
    })

    it("answers every question from DEMOS_SETUP_* variables", async () => {
        const { code } = await cli(["--yes"], {
            env: { DEMOS_SETUP_L2PS_UID: "from_env", DEMOS_SETUP_HISTORY_STORE_PLAINTEXT: "false", DEMOS_SETUP_L2PS_RPC: "http://a:1" },
        })
        expect(code).toBe(0)
        expect(fs.existsSync(subnetFile("from_env", "config.json"))).toBe(true)
        expect(envOf().L2PS_HISTORY_STORE_PLAINTEXT).toBe("false")
    })

    it("fails with the exact flag name when a required answer is missing", async () => {
        const { code, out } = await cli(["--yes", "--l2ps"])
        expect(code).toBe(1)
        expect(out).toContain("--l2ps-uid")
        expect(out).toContain("DEMOS_SETUP_L2PS_UID")
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
    })

    it("does nothing without a request instead of guessing", async () => {
        const { code, out } = await cli(["--yes"])
        expect(code).toBe(0)
        expect(out).toContain("Nothing requested")
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
        expect(fs.existsSync(path.join(root, ".env"))).toBe(false)
    })

    it("never asks a question without a terminal, even without --yes", async () => {
        const boom: Prompter = { readLine: async () => { throw new Error("must not prompt") } }
        const { code, out } = await cli(["--l2ps-uid", "demo_1"], { isTTY: false, prompter: boom })
        expect(code).toBe(0)
        expect(out).toContain("No terminal detected")
        expect(fs.existsSync(subnetFile("demo_1", "config.json"))).toBe(true)
    })

    it("is idempotent: a second run changes nothing", async () => {
        const args = ["--yes", "--l2ps-uid", "demo_1", "--messaging", "--history-retention-days", "5"]
        await cli(args)
        const before = fs.readFileSync(subnetFile("demo_1", "private_key.txt"), "utf8")
        const envBefore = fs.readFileSync(path.join(root, ".env"), "utf8")
        const { code, out } = await cli(args)
        expect(code).toBe(0)
        expect(out).toContain("unchanged data/l2ps/demo_1/private_key.txt")
        expect(out).not.toContain("created data")
        expect(fs.readFileSync(subnetFile("demo_1", "private_key.txt"), "utf8")).toBe(before)
        expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe(envBefore)
        expect(fs.readdirSync(path.dirname(subnetFile("demo_1", "x"))).filter(f => f.includes(".bak-"))).toEqual([])
    })

    it("rejects invalid answers before touching anything", async () => {
        for (const bad of [["--l2ps-uid", "no good"], ["--messaging-port", "0"], ["--l2ps-rpc", "ftp://x"]]) {
            const { code, out } = await cli(["--yes", ...bad])
            expect(code).toBe(2)
            expect(out).toContain("--help")
        }
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
    })
})

describe("joining with an imported key", () => {
    it("takes the key and IV from variables and keeps them out of the output", async () => {
        const { code, out } = await cli(["--yes", "--l2ps-uid", "shared_1", "--l2ps-role", "join"], {
            env: { DEMOS_SETUP_L2PS_KEY: HEX_KEY, DEMOS_SETUP_L2PS_IV: HEX_IV },
        })
        expect(code).toBe(0)
        expect(fs.readFileSync(subnetFile("shared_1", "private_key.txt"), "utf8").trim()).toBe(HEX_KEY)
        expect(fs.readFileSync(subnetFile("shared_1", "iv.txt"), "utf8").trim()).toBe(HEX_IV)
        expect(out).not.toContain(HEX_KEY)
        expect(out).not.toContain(HEX_IV)
    })

    it("takes the key and IV from files", async () => {
        const kf = path.join(root, "k.txt")
        const iv = path.join(root, "i.txt")
        fs.writeFileSync(kf, "0x" + HEX_KEY.toUpperCase() + "\n")
        fs.writeFileSync(iv, HEX_IV)
        const { code } = await cli(["--yes", "--l2ps-uid", "shared_1", "--l2ps-key-file", kf, "--l2ps-iv-file", iv])
        expect(code).toBe(0)
        expect(fs.readFileSync(subnetFile("shared_1", "private_key.txt"), "utf8").trim()).toBe(HEX_KEY)
    })

    it("refuses a malformed key and writes nothing", async () => {
        const { code, out } = await cli(["--yes", "--l2ps-uid", "shared_1", "--l2ps-role", "join"], {
            env: { DEMOS_SETUP_L2PS_KEY: "nothex", DEMOS_SETUP_L2PS_IV: HEX_IV },
        })
        expect(code).toBe(1)
        expect(out).toContain("non-hex")
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
    })

    it("needs both key and IV when nobody can be asked", async () => {
        const { code, out } = await cli(["--yes", "--l2ps-uid", "shared_1", "--l2ps-role", "join"], {
            env: { DEMOS_SETUP_L2PS_KEY: HEX_KEY },
        })
        expect(code).toBe(1)
        expect(out).toContain("DEMOS_SETUP_L2PS_IV")
    })
})

describe("the do-not-overwrite guard", () => {
    const otherKey = "11".repeat(32)
    const joinArgs = ["--yes", "--l2ps-uid", "keep_me", "--l2ps-role", "join"]

    it("refuses a join whose key differs, exits 1 and never says ready", async () => {
        writeSubnet(root, "keep_me")
        const { code, out } = await cli(joinArgs, { env: { DEMOS_SETUP_L2PS_KEY: otherKey, DEMOS_SETUP_L2PS_IV: HEX_IV } })
        expect(code).toBe(1)
        expect(out).toContain("key differs; re-run with --force")
        expect(out).not.toContain("is ready")
        expect(fs.readFileSync(subnetFile("keep_me", "private_key.txt"), "utf8").trim()).toBe(HEX_KEY)
        expect(fs.readdirSync(path.dirname(subnetFile("keep_me", "x"))).filter(f => f.includes(".bak-"))).toEqual([])
    })

    it("also refuses a differing IV, and changes nothing else when it refuses", async () => {
        writeSubnet(root, "keep_me")
        const cfgBefore = fs.readFileSync(subnetFile("keep_me", "config.json"), "utf8")
        const { code, out } = await cli([...joinArgs, "--l2ps-rpc", "http://other:1"], { env: { DEMOS_SETUP_L2PS_KEY: HEX_KEY, DEMOS_SETUP_L2PS_IV: "11".repeat(16) } })
        expect(code).toBe(1)
        expect(out).toContain("IV differs; re-run with --force")
        expect(fs.readFileSync(subnetFile("keep_me", "config.json"), "utf8")).toBe(cfgBefore)
    })

    it("does not call a trailing-newline-only difference a difference", async () => {
        const dir = writeSubnet(root, "keep_me")
        fs.writeFileSync(path.join(dir, "private_key.txt"), HEX_KEY, { mode: 0o600 }) // no newline
        const { code, out } = await cli(joinArgs, { env: { DEMOS_SETUP_L2PS_KEY: "0x" + HEX_KEY.toUpperCase() + "\n", DEMOS_SETUP_L2PS_IV: HEX_IV } })
        expect(code).toBe(0)
        expect(out).toContain("unchanged data/l2ps/keep_me/private_key.txt")
        expect(out).toContain("is ready")
        expect(fs.readFileSync(path.join(dir, "private_key.txt"), "utf8")).toBe(HEX_KEY)
    })

    it("replaces it with --force and keeps the old one as a backup", async () => {
        writeSubnet(root, "keep_me")
        const { out } = await cli([...joinArgs, "--force"], { env: { DEMOS_SETUP_L2PS_KEY: otherKey, DEMOS_SETUP_L2PS_IV: HEX_IV } })
        expect(out).toContain("replaced data/l2ps/keep_me/private_key.txt")
        expect(fs.readFileSync(subnetFile("keep_me", "private_key.txt"), "utf8").trim()).toBe(otherKey)
        const backups = fs.readdirSync(path.dirname(subnetFile("keep_me", "x"))).filter(f => f.startsWith("private_key.txt.bak-"))
        expect(backups).toHaveLength(1)
        expect(fs.readFileSync(subnetFile("keep_me", backups[0]), "utf8").trim()).toBe(HEX_KEY)
    })

    it("asks before replacing and defaults to no", async () => {
        writeSubnet(root, "keep_me")
        // Per differing file: key then (the IV and config are unchanged).
        const decline = scriptedPrompter(["", "", ""])
        // Flags answer the questions; only the replace confirmations remain.
        const args = [...joinArgs.filter(a => a !== "--yes"), "--l2ps-rpc", "http://127.0.0.1:53550",
            "--history-retention-days", "0", "--no-history-store-plaintext", "--no-history-require-v2", "--no-messaging", "--no-zk"]
        const env = { DEMOS_SETUP_L2PS_KEY: otherKey, DEMOS_SETUP_L2PS_IV: HEX_IV }
        await cli(args, { env, isTTY: true, prompter: decline })
        expect(decline.asked.some(q => q.includes("already exists with different content"))).toBe(true)
        expect(fs.readFileSync(subnetFile("keep_me", "private_key.txt"), "utf8").trim()).toBe(HEX_KEY)

        const accept = scriptedPrompter(["y", "y", "y"])
        await cli(args, { env, isTTY: true, prompter: accept })
        expect(fs.readFileSync(subnetFile("keep_me", "private_key.txt"), "utf8").trim()).toBe(otherKey)
    })

    it("reuses the key already on disk when no new key is given", async () => {
        writeSubnet(root, "keep_me", { iv: null })
        await cli(["--yes", "--l2ps-uid", "keep_me"])
        expect(fs.readFileSync(subnetFile("keep_me", "private_key.txt"), "utf8").trim()).toBe(HEX_KEY)
        expect(fs.existsSync(subnetFile("keep_me", "iv.txt"))).toBe(true)
    })

    it("leaves a differing .env value alone unless forced, and backs it up when forced", async () => {
        fs.writeFileSync(path.join(root, ".env"), "L2PS_HISTORY_RETENTION_DAYS=90\nPG_PASSWORD=secret\n")
        const base = ["--yes", "--l2ps-uid", "demo_1", "--history-retention-days", "7"]
        const first = await cli(base)
        expect(first.out).toContain("kept L2PS_HISTORY_RETENTION_DAYS=90")
        expect(envOf().L2PS_HISTORY_RETENTION_DAYS).toBe("90")
        await cli([...base, "--force"])
        expect(envOf()).toMatchObject({ L2PS_HISTORY_RETENTION_DAYS: "7", PG_PASSWORD: "secret" })
        expect(fs.readdirSync(root).some(f => f.startsWith(".env.bak-"))).toBe(true)
    })
})

describe("dry run", () => {
    it("prints the plan and writes nothing", async () => {
        installZkTools(root)
        const { code, out } = await cli(["--yes", "--dry-run", "--l2ps-uid", "demo_1", "--messaging", "--zk"])
        expect(code).toBe(0)
        expect(out).toContain("would create: data/l2ps/demo_1/private_key.txt")
        expect(out).toContain("would set L2PS_MESSAGING_ENABLED=true")
        expect(out).toContain("Dry run finished")
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
        expect(fs.existsSync(path.join(root, ".env"))).toBe(false)
    })
})

describe("interactive setup (mocked prompts)", () => {
    it("walks through L2PS and ZK and writes what was answered", async () => {
        const p = scriptedPrompter([
            "y",        // enable L2PS
            "demo_1",   // subnet id
            "",         // new subnet (default)
            "http://10.0.0.5:53550,http://10.0.0.6:53550",
            "7",        // retention days
            "n",        // plaintext
            "n",        // require v2
            "y",        // messaging
            "3100",     // messaging port
            "n",        // ZK for batches
        ])
        const { code, out } = await cli([], { isTTY: true, prompter: p })
        expect(code).toBe(0)
        const cfg = JSON.parse(fs.readFileSync(subnetFile("demo_1", "config.json"), "utf8"))
        expect(cfg.config.known_rpcs).toEqual(["http://10.0.0.5:53550", "http://10.0.0.6:53550"])
        // Only what differs from the built-in defaults is written.
        expect(envOf()).toEqual({
            L2PS_HISTORY_RETENTION_DAYS: "7",
            L2PS_MESSAGING_ENABLED: "true",
            L2PS_MESSAGING_PORT: "3100",
        })
        expect(out).toContain("Identity proofs: ready")
        expect(p.asked.join("\n")).not.toContain("hidden") // create path asks for no secrets
    })

    it("re-asks on an invalid subnet id and port", async () => {
        const p = scriptedPrompter(["y", "bad id", "ok_1", "", "http://a:1", "0", "n", "n", "y", "99999", "3000", "n"])
        const { out } = await cli([], { isTTY: true, prompter: p })
        expect(out).toContain("Use letters, digits")
        expect(out).toContain("Port must be 1-65535")
        expect(envOf().L2PS_MESSAGING_PORT).toBe("3000")
    })

    it("imports a key through hidden prompts when joining", async () => {
        const p = scriptedPrompter(["y", "shared_1", "2", HEX_KEY, HEX_IV, "", "0", "n", "n", "n", "n"])
        const { out } = await cli([], { isTTY: true, prompter: p })
        expect(fs.readFileSync(subnetFile("shared_1", "private_key.txt"), "utf8").trim()).toBe(HEX_KEY)
        expect(out).not.toContain(HEX_KEY)
    })

    it("declining L2PS touches nothing", async () => {
        const p = scriptedPrompter(["n"])
        const { code } = await cli([], { isTTY: true, prompter: p })
        expect(code).toBe(0)
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
        expect(fs.existsSync(path.join(root, ".env"))).toBe(false)
    })
})

describe("ZK step", () => {
    function seedVkeys() {
        for (const size of [5, 10]) {
            const dir = path.join(root, "src/libs/l2ps/zk/keys", `batch_${size}`)
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, "verification_key.json"), JSON.stringify({ protocol: "plonk" }))
        }
    }

    it("tells the operator to install dependencies when the build tools are missing", async () => {
        writeSubnet(root, "good")
        const { code, out } = await cli(["--yes", "--zk"])
        expect(code).toBe(1)
        expect(out).toContain("Run \"bun install\" first")
    })

    it("turns proofs on, builds the keys and passes the final check", async () => {
        writeSubnet(root, "good")
        installZkTools(root)
        seedVkeys()
        const runner = fakeRunner()
        const { code, out } = await cli(["--yes", "--zk", "--zk-generate"], { runner })
        expect(code).toBe(0)
        expect(runner.calls.filter(c => c.startsWith("download"))).toHaveLength(2)
        expect(envOf().L2PS_ZK_ENABLED).toBe("true")
        expect(out).not.toContain("MISSING")
    })

    it("--yes --zk alone never downloads and leaves L2PS_ZK_ENABLED untouched", async () => {
        writeSubnet(root, "good")
        installZkTools(root)
        const runner = fakeRunner()
        const { code, out } = await cli(["--yes", "--zk"], { runner })
        expect(code).toBe(0)
        expect(runner.calls).toEqual([])
        expect(out).toContain("--zk-generate")
        expect(out).toContain("L2PS_ZK_ENABLED was left unchanged")
        expect(fs.existsSync(path.join(root, ".env"))).toBe(false)
    })

    it("leaves L2PS_ZK_ENABLED untouched when the build fails", async () => {
        writeSubnet(root, "good")
        installZkTools(root)
        seedVkeys()
        fs.writeFileSync(path.join(root, ".env"), "L2PS_ZK_ENABLED=false\n")
        const { code, out } = await cli(["--yes", "--zk", "--zk-generate"], { runner: fakeRunner({ failOn: "plonk setup" }) })
        expect(code).toBe(1)
        expect(out).toContain("L2PS_ZK_ENABLED was left unchanged")
        expect(envOf().L2PS_ZK_ENABLED).toBe("false")
    })

    it("leaves it untouched when the user declines to build", async () => {
        writeSubnet(root, "good")
        installZkTools(root)
        const p = scriptedPrompter(["y", "n"]) // Use ZK proofs? yes; build now? no
        const { out } = await cli(["--l2ps", "--l2ps-uid", "good", "--l2ps-rpc", "http://127.0.0.1:53550", "--history-retention-days", "0", "--no-history-store-plaintext", "--no-history-require-v2", "--no-messaging"], { isTTY: true, prompter: p })
        expect(out).toContain("L2PS_ZK_ENABLED was left unchanged")
        expect(fs.existsSync(path.join(root, ".env")) ? envOf().L2PS_ZK_ENABLED : undefined).toBeUndefined()
    })

    it("does not build again when every size is already in place", async () => {
        writeSubnet(root, "good")
        installZkTools(root)
        writeZkBatch(root, 5)
        writeZkBatch(root, 10)
        const runner = fakeRunner()
        await cli(["--yes", "--zk", "--zk-generate"], { runner })
        expect(runner.calls).toEqual([])
        expect(envOf().L2PS_ZK_ENABLED).toBe("true")
    })

    it("does not build when --no-zk-generate is given and says how to do it later", async () => {
        writeSubnet(root, "good")
        installZkTools(root)
        const runner = fakeRunner()
        const { out } = await cli(["--yes", "--zk", "--no-zk-generate"], { runner })
        expect(runner.calls).toEqual([])
        expect(out).toContain("bun run setup --only zk --zk --zk-generate")
    })

    it("skips ZK when there is no subnet to prove for", async () => {
        const runner = fakeRunner()
        const { code, out } = await cli(["--yes", "--zk"], { runner })
        expect(code).toBe(0)
        expect(out).toContain("no batches to prove")
        expect(runner.calls).toEqual([])
        expect(fs.existsSync(path.join(root, ".env"))).toBe(false)
    })

    it("turns proofs off explicitly with --no-zk", async () => {
        writeSubnet(root, "good")
        await cli(["--yes", "--no-zk"])
        expect(envOf().L2PS_ZK_ENABLED).toBe("false")
    })

    it("reports a corrupt identity key without trying to regenerate it", async () => {
        fs.writeFileSync(path.join(root, "src/features/zk/keys/verification_key_merkle.json"), "{}")
        const runner = fakeRunner()
        const { code, out } = await cli(["--yes", "--only", "zk"], { runner })
        expect(code).toBe(1)
        expect(out).toContain("restore the committed src/features/zk/keys/verification_key_merkle.json")
        expect(out).not.toContain("git checkout")
        expect(runner.calls).toEqual([])
    })
})

describe("env file that cannot be written", () => {
    it("prints the lines to add by hand instead of failing", async () => {
        const ro = path.join(root, "ro")
        fs.mkdirSync(ro)
        fs.chmodSync(ro, 0o555)
        try {
            const { code, out } = await cli(["--yes", "--l2ps-uid", "demo_1", "--messaging", "--env-file", "ro/.env"])
            expect(code).toBe(0)
            expect(out).toContain("Add these lines to your .env by hand")
            expect(out).toContain("L2PS_MESSAGING_ENABLED=true")
        } finally {
            fs.chmodSync(ro, 0o755)
        }
    })
})

describe("--check", () => {
    it("exits 0 with nothing to fix", async () => {
        const { code, out } = await cli(["--check"])
        expect(code).toBe(0)
        expect(out).toContain("Nothing to fix")
    })

    it("exits 1 and names the fix when something is missing", async () => {
        writeSubnet(root, "broken", { key: null })
        const { code, out } = await cli(["--check"])
        expect(code).toBe(1)
        expect(out).toContain("MISSING")
        expect(out).toContain("To fix: bun run setup --only l2ps")
    })

    it("can print JSON for CI", async () => {
        writeSubnet(root, "broken", { key: null })
        const { code, out } = await cli(["--check", "--json"])
        expect(code).toBe(1)
        const parsed = JSON.parse(out)
        expect(parsed.ok).toBe(false)
        expect(parsed.items.some((i: any) => i.status === "missing")).toBe(true)
    })

    it("writes nothing", async () => {
        await cli(["--check", "--l2ps-uid", "demo_1"])
        expect(fs.existsSync(path.join(root, "data"))).toBe(false)
    })
})

describe("repairing an existing subnet", () => {
    it("fills in the missing key without touching the rest of config.json", async () => {
        const dir = writeSubnet(root, "keepcfg", {
            key: null,
            config: {
                uid: "keepcfg", enabled: true, name: "My subnet",
                config: { created_at_block: 12, known_rpcs: ["http://peer:1"], network_params: { max_tx_per_block: 5 } },
                keys: { private_key_path: "data/l2ps/keepcfg/private_key.txt", iv_path: "data/l2ps/keepcfg/iv.txt" },
            },
        })
        const before = fs.readFileSync(path.join(dir, "config.json"), "utf8")
        const { code, out } = await cli(["--yes", "--l2ps-uid", "keepcfg"])
        expect(code).toBe(0)
        expect(out).toContain("unchanged data/l2ps/keepcfg/config.json")
        expect(fs.readFileSync(path.join(dir, "config.json"), "utf8")).toBe(before)
        expect(fs.existsSync(path.join(dir, "private_key.txt"))).toBe(true)
    })

    it("asks before changing the RPC list of an existing subnet", async () => {
        writeSubnet(root, "keepcfg")
        const { out } = await cli(["--yes", "--l2ps-uid", "keepcfg", "--l2ps-rpc", "http://new:9"])
        expect(out).toContain("kept data/l2ps/keepcfg/config.json")
        expect(JSON.parse(fs.readFileSync(subnetFile("keepcfg", "config.json"), "utf8")).config.known_rpcs).toEqual(["http://127.0.0.1:53550"])
    })
})


describe("defaults are not written", () => {
    it("accepting every default in an interactive run leaves no .env behind", async () => {
        // enable L2PS, id, new subnet, rpc, retention, plaintext, v2, messaging, zk
        const p = scriptedPrompter(["y", "demo_1", "", "", "", "", "", "", ""])
        const { code } = await cli([], { isTTY: true, prompter: p })
        expect(code).toBe(0)
        expect(fs.existsSync(path.join(root, ".env"))).toBe(false)
    })

    it("still writes a value that differs from what is in effect", async () => {
        fs.writeFileSync(path.join(root, ".env"), "L2PS_HISTORY_RETENTION_DAYS=90\n")
        // ... then the confirmation to change the existing value
        const p = scriptedPrompter(["y", "demo_1", "", "", "0", "", "", "", "", "y"])
        await cli([], { isTTY: true, prompter: p, env: { L2PS_HISTORY_RETENTION_DAYS: "90" } })
        expect(envOf().L2PS_HISTORY_RETENTION_DAYS).toBe("0")
    })

    it("explicit flags are written even when they equal a default", async () => {
        await cli(["--yes", "--l2ps-uid", "demo_1", "--history-retention-days", "0"])
        expect(envOf().L2PS_HISTORY_RETENTION_DAYS).toBe("0")
    })
})

describe("the result table shows what was just written", () => {
    it("overrides a stale process environment for the keys the wizard wrote", async () => {
        // `bun run` has already loaded the old .env into the environment.
        fs.writeFileSync(path.join(root, ".env"), "L2PS_MESSAGING_ENABLED=false\n")
        const { out } = await cli(["--yes", "--l2ps-uid", "demo_1", "--messaging", "--force"], {
            env: { L2PS_MESSAGING_ENABLED: "false" },
        })
        expect(envOf().L2PS_MESSAGING_ENABLED).toBe("true")
        expect(out).toContain("Subnet for messaging")
        expect(out).not.toContain("Messaging          off")
    })
})

describe("inside the container image", () => {
    it("does not write /app/.env and hands over the lines for the host", async () => {
        const { code, out } = await cli(["--yes", "--l2ps-uid", "demo_1", "--messaging"], { inDocker: true })
        expect(code).toBe(0)
        expect(fs.existsSync(path.join(root, ".env"))).toBe(false)
        expect(out).toContain("container image")
        expect(out).toContain("L2PS_MESSAGING_ENABLED=true")
        // The subnet files do go to the data volume.
        expect(fs.existsSync(subnetFile("demo_1", "private_key.txt"))).toBe(true)
    })

    it("writes the file when the operator names one explicitly", async () => {
        await cli(["--yes", "--l2ps-uid", "demo_1", "--messaging", "--env-file", "custom.env"], { inDocker: true })
        expect(parseEnv(fs.readFileSync(path.join(root, "custom.env"), "utf8")).L2PS_MESSAGING_ENABLED).toBe("true")
    })
})

describe("custom key paths in an existing config.json", () => {
    const custom = (extra: object = {}) => ({
        uid: "cust", enabled: true,
        config: { created_at_block: 0, known_rpcs: ["http://127.0.0.1:53550"] },
        keys: { private_key_path: "data/l2ps/cust/keys/k.txt", iv_path: "data/l2ps/cust/keys/i.txt" },
        ...extra,
    })

    it("reuses the key at the configured location and fills in the missing IV there", async () => {
        const dir = writeSubnet(root, "cust", { config: custom(), key: null, iv: null })
        fs.mkdirSync(path.join(dir, "keys"))
        fs.writeFileSync(path.join(dir, "keys/k.txt"), HEX_KEY + "\n", { mode: 0o600 })
        const { code } = await cli(["--yes", "--l2ps-uid", "cust"])
        expect(code).toBe(0)
        expect(fs.readFileSync(path.join(dir, "keys/k.txt"), "utf8").trim()).toBe(HEX_KEY)
        expect(fs.existsSync(path.join(dir, "keys/i.txt"))).toBe(true)
        expect(fs.existsSync(path.join(dir, "private_key.txt"))).toBe(false)
    })

    it("--force replaces the key at the configured location, with a backup there", async () => {
        const dir = writeSubnet(root, "cust", { config: custom(), key: null, iv: null })
        fs.mkdirSync(path.join(dir, "keys"))
        fs.writeFileSync(path.join(dir, "keys/k.txt"), HEX_KEY + "\n", { mode: 0o600 })
        fs.writeFileSync(path.join(dir, "keys/i.txt"), HEX_IV + "\n", { mode: 0o600 })
        const other = "11".repeat(32)
        const { code } = await cli(["--yes", "--l2ps-uid", "cust", "--l2ps-role", "join", "--force"], { env: { DEMOS_SETUP_L2PS_KEY: other, DEMOS_SETUP_L2PS_IV: HEX_IV } })
        expect(code).toBe(0)
        expect(fs.readFileSync(path.join(dir, "keys/k.txt"), "utf8").trim()).toBe(other)
        expect(fs.readdirSync(path.join(dir, "keys")).some(f => f.startsWith("k.txt.bak-"))).toBe(true)
        expect(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).keys.private_key_path).toBe("data/l2ps/cust/keys/k.txt")
    })
})

describe("file modes", () => {
    it("does not widen an operator's 600 config.json", async () => {
        const dir = writeSubnet(root, "keep_me")
        fs.chmodSync(path.join(dir, "config.json"), 0o600)
        await cli(["--yes", "--l2ps-uid", "keep_me"])
        expect(fs.statSync(path.join(dir, "config.json")).mode & 0o777).toBe(0o600)
    })

    it("tightens a key file that was too open", async () => {
        const dir = writeSubnet(root, "keep_me")
        fs.chmodSync(path.join(dir, "private_key.txt"), 0o644)
        await cli(["--yes", "--l2ps-uid", "keep_me"])
        expect(fs.statSync(path.join(dir, "private_key.txt")).mode & 0o777).toBe(0o600)
    })
})

describe("matching the loader", () => {
    it("rejects a subnet id the loader would refuse and accepts a long one", async () => {
        expect((await cli(["--yes", "--l2ps-uid", "has.dot"])).code).toBe(2)
        expect((await cli(["--yes", "--l2ps-uid", "a".repeat(80)])).code).toBe(0)
    })

    it("accepts an imported key with a 0X prefix and inner whitespace", async () => {
        const spaced = "0X" + HEX_KEY.slice(0, 32) + " \n" + HEX_KEY.slice(32)
        const { code } = await cli(["--yes", "--l2ps-uid", "shared_1", "--l2ps-role", "join"], { env: { DEMOS_SETUP_L2PS_KEY: spaced, DEMOS_SETUP_L2PS_IV: HEX_IV } })
        expect(code).toBe(0)
        expect(fs.readFileSync(subnetFile("shared_1", "private_key.txt"), "utf8").trim()).toBe(HEX_KEY)
    })
})

describe("absolute key paths in config.json", () => {
    it("reads and writes them where the loader looks, not under the root twice", async () => {
        const dir = path.join(root, "data/l2ps/abs")
        fs.mkdirSync(dir, { recursive: true })
        const keyAbs = path.join(dir, "key.txt")
        const ivAbs = path.join(dir, "iv.txt")
        fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
            uid: "abs", enabled: true,
            config: { created_at_block: 0, known_rpcs: ["http://127.0.0.1:53550"] },
            keys: { private_key_path: keyAbs, iv_path: ivAbs },
        }))
        fs.writeFileSync(keyAbs, HEX_KEY + "\n", { mode: 0o600 })
        const { code, out } = await cli(["--yes", "--l2ps-uid", "abs"])
        expect(code).toBe(0)
        expect(fs.readFileSync(keyAbs, "utf8").trim()).toBe(HEX_KEY) // reused, not regenerated
        expect(fs.existsSync(ivAbs)).toBe(true) // created at the real location
        expect(fs.existsSync(path.join(root, root))).toBe(false) // no <root><root>/... copy
        expect(out).toContain("is ready")
    })
})
