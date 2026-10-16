import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { describeProblems, enforceGuidedSetup, startupProblems, type GateDeps } from "./startupGate"
import { CODE_ROOT, createContext } from "./context"
import { SetupAborted, SetupTimedOut, type Prompter } from "./prompt"
import { makeRoot, recorder, removeRoot, scriptedPrompter, writeSubnet } from "./testSupport"

class Exit extends Error {
    constructor(public code: number) {
        super(`exit ${code}`)
    }
}

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

function gate(over: Partial<GateDeps>) {
    const r = recorder()
    const logged: string[] = []
    const deps: Partial<GateDeps> = {
        cwd: root,
        codeRoot: root,
        env: {},
        interactive: false,
        inDocker: false,
        say: r.say,
        logError: m => {
            logged.push(m)
        },
        exit: ((code: number) => {
            throw new Exit(code)
        }) as GateDeps["exit"],
        ...over,
    }
    return { run: () => enforceGuidedSetup(deps), out: r.text, logged }
}

const neverPrompt: Prompter = {
    readLine: async () => {
        throw new Error("must not prompt")
    },
}

describe("a feature problem never stops a node by itself", () => {
    it("is silent for a healthy or L2PS-free node", async () => {
        const g = gate({})
        await g.run()
        expect(g.out()).toBe("")
        expect(g.logged).toEqual([])
        writeSubnet(root, "good")
        await gate({ env: { L2PS_MESSAGING_ENABLED: "true" } }).run()
    })

    it("prints a banner and logs it, then lets the boot continue (no exit)", async () => {
        writeSubnet(root, "broken", { key: null })
        const g = gate({ prompter: neverPrompt })
        await g.run() // resolves: the node keeps booting
        const out = g.out()
        expect(out).toContain("DEMOS NODE SETUP WARNING")
        expect(out).toContain("Subnet broken")
        expect(out).toContain("private_key.txt is missing")
        expect(out).toContain("bun run setup --only l2ps")
        expect(out).toContain("keeps booting")
        expect(out).toContain("DEMOS_SETUP_STRICT=true")
        expect(g.logged).toHaveLength(1)
        expect(g.logged[0]).toContain("private_key.txt is missing")
    })

    it("covers messaging without a subnet and explicit ZK without keys", async () => {
        const m = gate({ env: { L2PS_MESSAGING_ENABLED: "true" } })
        await m.run()
        expect(m.out()).toContain("messaging is on but no usable subnet exists")
        writeSubnet(root, "good")
        const z = gate({ env: { L2PS_ZK_ENABLED: "true" } })
        await z.run()
        expect(z.out()).toContain("bun run setup --only zk")
    })

    it("lists every problem, not just the first", async () => {
        writeSubnet(root, "a", { key: null })
        writeSubnet(root, "b", { iv: null })
        const g = gate({})
        await g.run()
        expect(g.out()).toContain("Subnet a")
        expect(g.out()).toContain("Subnet b")
    })

    it("stops only when DEMOS_SETUP_STRICT is true", async () => {
        writeSubnet(root, "broken", { key: null })
        for (const value of ["true", "1"]) {
            const g = gate({ env: { DEMOS_SETUP_STRICT: value } })
            await expect(g.run()).rejects.toMatchObject({ code: 1 })
            expect(g.out()).toContain("DEMOS_SETUP_STRICT is on")
        }
        await gate({ env: { DEMOS_SETUP_STRICT: "false" } }).run()
        const viaDeps = gate({ strict: true })
        await expect(viaDeps.run()).rejects.toMatchObject({ code: 1 })
    })

    it("points docker users at the container", async () => {
        const g = gate({ env: { L2PS_MESSAGING_ENABLED: "true" }, inDocker: true })
        await g.run()
        expect(g.out()).toContain("docker compose exec node bun run setup --only l2ps")
    })

    it("can be skipped explicitly", async () => {
        writeSubnet(root, "broken", { key: null })
        const g = gate({ env: { DEMOS_SKIP_SETUP_CHECK: "true", DEMOS_SETUP_STRICT: "true" } })
        await g.run()
        expect(g.out()).toBe("")
    })

    it("reads the env file, not only the process environment", async () => {
        fs.writeFileSync(path.join(root, ".env"), "L2PS_MESSAGING_ENABLED=true\n")
        const g = gate({})
        await g.run()
        expect(g.out()).toContain("messaging is on")
    })

    it("describeProblems names the problem items", () => {
        writeSubnet(root, "broken", { iv: null })
        const text = describeProblems(startupProblems(createContext(root, ".env", {})), false)
        expect(text).toContain("iv.txt is missing")
    })
})

describe("the consensus-critical key always stops the node", () => {
    const vkey = () => path.join(root, "src/features/zk/keys/verification_key_merkle.json")

    it("exits 1 when the identity verification key is missing, with its own message", async () => {
        fs.rmSync(vkey())
        const g = gate({ inDocker: true })
        await expect(g.run()).rejects.toMatchObject({ code: 1 })
        const out = g.out()
        expect(out).toContain("CANNOT START")
        expect(out).toContain("verification_key_merkle.json")
        expect(out).toContain("rebuild or re-pull the image")
        expect(out).not.toContain("L2PS or ZK is configured")
        expect(out).not.toContain("docker compose exec")
        expect(out).not.toContain("git checkout")
        expect(g.logged).toHaveLength(1)
    })

    it("exits 1 for a corrupt key, with or without the skip switch and without strict mode", async () => {
        fs.writeFileSync(vkey(), "{ not json")
        for (const env of [{ DEMOS_SETUP_STRICT: "false" }, { DEMOS_SKIP_SETUP_CHECK: "true" }]) {
            await expect(gate({ env }).run()).rejects.toMatchObject({ code: 1 })
        }
    })

    it("is not hidden behind other problems", async () => {
        fs.rmSync(vkey())
        writeSubnet(root, "broken", { key: null })
        const g = gate({})
        await expect(g.run()).rejects.toMatchObject({ code: 1 })
        expect(g.out()).not.toContain("DEMOS NODE SETUP WARNING")
    })
})

describe("inspection never crashes the start", () => {
    it("reports an unreadable data directory as a problem and keeps booting", async () => {
        fs.mkdirSync(path.join(root, "data"), { recursive: true })
        fs.writeFileSync(path.join(root, "data/l2ps"), "x")
        const g = gate({})
        await g.run()
        expect(g.out()).toContain("cannot be read")
    })

    it("reports an unreadable key file as a problem and keeps booting", async () => {
        const dir = writeSubnet(root, "weird")
        fs.rmSync(path.join(dir, "iv.txt"))
        fs.mkdirSync(path.join(dir, "iv.txt"))
        const g = gate({})
        await g.run()
        expect(g.out()).toContain("cannot be read")
    })
})

describe("with a terminal", () => {
    it("offers the setup with a 30 second window that defaults to no", async () => {
        writeSubnet(root, "broken", { key: null })
        const seen: Array<{ q: string; timeoutMs?: number }> = []
        const p: Prompter = {
            readLine: async (q, o) => {
                seen.push({ q, timeoutMs: o?.timeoutMs })
                return ""
            },
        }
        const g = gate({ interactive: true, prompter: p })
        await g.run()
        expect(seen).toHaveLength(1)
        expect(seen[0].timeoutMs).toBe(30_000)
        expect(seen[0].q).toContain("[y/N]")
        expect(g.out()).toContain("Continuing without the setup")
        expect(fs.existsSync(path.join(root, "data/l2ps/broken/private_key.txt"))).toBe(false)
    })

    it("continues booting when nobody answers in time", async () => {
        writeSubnet(root, "broken", { key: null })
        const g = gate({
            interactive: true,
            prompter: { readLine: async () => { throw new SetupTimedOut() } },
        })
        await g.run()
        expect(g.out()).toContain("No answer in time")
    })

    it("Ctrl-C aborts the start with exit code 130, it never continues", async () => {
        writeSubnet(root, "broken", { key: null })
        const g = gate({
            interactive: true,
            prompter: { readLine: async () => { throw new SetupAborted() } },
        })
        await expect(g.run()).rejects.toMatchObject({ code: 130 })
        expect(g.out()).toContain("Aborted by the operator")
    })

    it("Ctrl-C inside the inline setup also aborts the start", async () => {
        writeSubnet(root, "broken", { key: null })
        let n = 0
        const g = gate({
            interactive: true,
            prompter: {
                readLine: async () => {
                    if (n++ === 0) return "y"
                    throw new SetupAborted()
                },
            },
        })
        await expect(g.run()).rejects.toMatchObject({ code: 130 })
    })

    it("runs the setup inline on yes and asks for a restart when the env file changed", async () => {
        writeSubnet(root, "broken", { key: null })
        // Run setup? y; repair? y; uid default; new subnet; rpc default; retention 7 (changed);
        // plaintext n; v2 n; messaging n; ZK n.
        const p = scriptedPrompter(["y", "y", "", "", "", "7", "n", "n", "n", "n"])
        const g = gate({ interactive: true, prompter: p })
        await expect(g.run()).rejects.toMatchObject({ code: 0 })
        expect(fs.existsSync(path.join(root, "data/l2ps/broken/private_key.txt"))).toBe(true)
        expect(g.out()).toContain("Start the node again")
    })

    it("strict mode stops before any question", async () => {
        writeSubnet(root, "broken", { key: null })
        const g = gate({ interactive: true, strict: true, prompter: neverPrompt })
        await expect(g.run()).rejects.toMatchObject({ code: 1 })
    })
})

describe("the report reaches the operator when the real logger filters it out", () => {
    const harness = path.join(import.meta.dir, "gateHarness.ts")

    function boot(logLevel: string) {
        const bare = makeRoot({ identityKey: false })
        try {
            const r = spawnSync(process.execPath, [harness], {
                // The checkout is the working directory, as for the node: the logger's decorators
                // need its tsconfig. HARNESS_ROOT points the gate at the bare directory.
                cwd: CODE_ROOT,
                encoding: "utf8",
                timeout: 60_000,
                env: { ...process.env, CI: "", LOG_LEVEL: logLevel, HARNESS_REAL_LOGGER: "1", HARNESS_ROOT: bare, DEMOS_SKIP_SETUP_CHECK: "" },
            })
            return { status: r.status, text: `${r.stdout}${r.stderr}` }
        } finally {
            removeRoot(bare)
        }
    }
    const count = (text: string) => text.split("DEMOS NODE CANNOT START").length - 1

    it("prints the refusal itself under LOG_LEVEL=critical, where the logger drops error lines", () => {
        const r = boot("critical")
        expect(r.status).toBe(1)
        expect(count(r.text)).toBe(1)
    })

    it("shows the refusal once, through the logger, under the default level", () => {
        const r = boot("info")
        expect(r.status).toBe(1)
        expect(count(r.text)).toBe(1)
    })
})
