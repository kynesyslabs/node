import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { enforceGuidedSetup, describeProblems, type GateDeps } from "./startupGate"
import { createContext } from "./context"
import { startupProblems } from "./startupGate"
import { makeRoot, recorder, removeRoot, scriptedPrompter, writeSubnet } from "./testSupport"
import { SetupAborted, type Prompter } from "./prompt"

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
    const deps: Partial<GateDeps> = {
        cwd: root,
        env: {},
        interactive: false,
        inDocker: false,
        say: r.say,
        exit: ((code: number) => {
            throw new Exit(code)
        }) as GateDeps["exit"],
        ...over,
    }
    return { run: () => enforceGuidedSetup(deps), out: r.text }
}

const neverPrompt: Prompter = {
    readLine: async () => {
        throw new Error("must not prompt")
    },
}

describe("startup gate without a terminal", () => {
    it("lets a healthy or L2PS-free node start without a word", async () => {
        const g = gate({})
        await g.run()
        expect(g.out()).toBe("")
        writeSubnet(root, "good")
        await gate({ env: { L2PS_MESSAGING_ENABLED: "true" } }).run()
    })

    it("stops with one message that lists exactly what is missing and the command to run", async () => {
        writeSubnet(root, "broken", { key: null })
        const g = gate({ prompter: neverPrompt })
        await expect(g.run()).rejects.toMatchObject({ code: 1 })
        const out = g.out()
        expect(out).toContain("Subnet broken")
        expect(out).toContain("private_key.txt is missing")
        expect(out).toContain("bun run setup --only l2ps")
        expect(out).toContain("DEMOS_SKIP_SETUP_CHECK=true")
        expect(out.split("\n").filter(l => l.startsWith("L2PS or ZK"))).toHaveLength(1)
    })

    it("points docker users at the container", async () => {
        const g = gate({ env: { L2PS_MESSAGING_ENABLED: "true" }, inDocker: true })
        await expect(g.run()).rejects.toBeInstanceOf(Exit)
        expect(g.out()).toContain("docker compose exec node bun run setup --only l2ps")
    })

    it("stops when ZK proofs are required but no keys exist", async () => {
        writeSubnet(root, "good")
        const g = gate({ env: { L2PS_ZK_ENABLED: "true" } })
        await expect(g.run()).rejects.toMatchObject({ code: 1 })
        expect(g.out()).toContain("bun run setup --only zk")
    })

    it("can be skipped explicitly", async () => {
        writeSubnet(root, "broken", { key: null })
        const g = gate({ env: { DEMOS_SKIP_SETUP_CHECK: "true" } })
        await g.run()
        expect(g.out()).toBe("")
    })

    it("reads the env file, not only the process environment", async () => {
        fs.writeFileSync(path.join(root, ".env"), "L2PS_MESSAGING_ENABLED=true\n")
        await expect(gate({}).run()).rejects.toMatchObject({ code: 1 })
    })

    it("describeProblems names the problem items", () => {
        writeSubnet(root, "broken", { iv: null })
        const text = describeProblems(startupProblems(createContext(root, ".env", {})), false)
        expect(text).toContain("iv.txt is missing")
    })
})

describe("startup gate with a terminal", () => {
    it("offers the setup, runs it inline and continues when only files changed", async () => {
        writeSubnet(root, "broken", { key: null })
        // Run setup? y; enable L2PS? (broken subnet exists) y; uid default; new subnet;
        // rpc default; retention; plaintext; v2; messaging; ZK.
        const p = scriptedPrompter(["y", "y", "", "", "", "0", "n", "n", "n", "n"])
        const g = gate({ interactive: true, prompter: p })
        await expect(g.run()).rejects.toMatchObject({ code: 0 }) // env entries were written
        expect(fs.existsSync(path.join(root, "data/l2ps/broken/private_key.txt"))).toBe(true)
        expect(g.out()).toContain("Start the node again")
    })

    it("lets the operator decline and carries on", async () => {
        writeSubnet(root, "broken", { key: null })
        const g = gate({ interactive: true, prompter: scriptedPrompter(["n"]) })
        await g.run()
        expect(g.out()).toContain("Continuing without it")
        expect(fs.existsSync(path.join(root, "data/l2ps/broken/private_key.txt"))).toBe(false)
    })

    it("treats Ctrl+C as a decline, not a crash", async () => {
        writeSubnet(root, "broken", { key: null })
        const g = gate({ interactive: true, prompter: { readLine: async () => { throw new SetupAborted() } } })
        await g.run()
        expect(g.out()).toContain("Setup cancelled")
    })
})
