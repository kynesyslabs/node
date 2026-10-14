import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { createReadlinePrompter, type Prompter } from "./prompt"
import { enforceGuidedSetup, type GateDeps } from "./startupGate"
import { makeRoot, recorder, removeRoot, writeSubnet } from "./testSupport"

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

interface Outcome {
    result: "returned" | "exit"
    code?: number
    out: string
    asked: string[]
    logged: string[]
}

async function gate(over: Partial<GateDeps>, answers: string[] = []): Promise<Outcome> {
    const r = recorder()
    const logged: string[] = []
    const asked: string[] = []
    const queue = [...answers]
    const prompter: Prompter = {
        async readLine(q) {
            asked.push(q)
            if (queue.length === 0) throw new Error("no scripted answer left")
            return queue.shift() as string
        },
    }
    const deps: Partial<GateDeps> = {
        cwd: root,
        env: {},
        interactive: false,
        inDocker: false,
        say: r.say,
        logError: m => {
            logged.push(m)
        },
        prompter,
        exit: ((code: number) => {
            throw new Exit(code)
        }) as GateDeps["exit"],
        ...over,
    }
    try {
        await enforceGuidedSetup(deps)
        return { result: "returned", out: r.text(), asked, logged }
    } catch (e) {
        if (e instanceof Exit) return { result: "exit", code: e.code, out: r.text(), asked, logged }
        throw e
    }
}

const breakIdentity = () => fs.rmSync(path.join(root, "src/features/zk/keys/verification_key_merkle.json"))

describe("every combination of strict, skip, terminal, docker and identity key", () => {
    const bools = [false, true]
    for (const strict of bools) {
        for (const skip of bools) {
            for (const interactive of bools) {
                for (const docker of bools) {
                    for (const identityOk of bools) {
                        for (const problem of bools) {
                            const name = `strict=${strict} skip=${skip} tty=${interactive} docker=${docker} identity=${identityOk} problem=${problem}`
                            it(name, async () => {
                                if (!identityOk) breakIdentity()
                                if (problem) writeSubnet(root, "broken", { key: null })
                                const env: Record<string, string> = {}
                                if (skip) env.DEMOS_SKIP_SETUP_CHECK = "true"
                                if (strict) env.DEMOS_SETUP_STRICT = "true"
                                const o = await gate({ env, strict, interactive, inDocker: docker }, ["n"])

                                if (!identityOk) {
                                    // Consensus-critical: nothing overrides it, and it never asks.
                                    expect(o).toMatchObject({ result: "exit", code: 1 })
                                    expect(o.out).toContain("CANNOT START")
                                    expect(o.asked).toEqual([])
                                    return
                                }
                                if (!problem || skip) {
                                    expect(o.result).toBe("returned")
                                    expect(o.out).toBe("")
                                    expect(o.asked).toEqual([])
                                    return
                                }
                                expect(o.out).toContain("DEMOS NODE SETUP WARNING")
                                expect(o.out.includes("docker compose exec node")).toBe(docker)
                                if (strict) {
                                    expect(o).toMatchObject({ result: "exit", code: 1 })
                                    expect(o.asked).toEqual([])
                                    return
                                }
                                // A headless validator is never held up by a question.
                                expect(o.result).toBe("returned")
                                expect(o.asked.length).toBe(interactive ? 1 : 0)
                            })
                        }
                    }
                }
            }
        }
    }
})

describe("a headless start never waits", () => {
    it("returns at once even when the prompter would block forever", async () => {
        writeSubnet(root, "broken", { key: null })
        const never: Prompter = { readLine: () => new Promise<string>(() => undefined) }
        const started = Date.now()
        const done = await Promise.race([
            gate({ interactive: false, prompter: never }).then(() => "done"),
            new Promise<string>(resolve => setTimeout(() => resolve("blocked"), 3000)),
        ])
        expect(done).toBe("done")
        expect(Date.now() - started).toBeLessThan(2500)
    })

    it("with a terminal, an unanswered offer ends after the window through a real readline", async () => {
        writeSubnet(root, "broken", { key: null })
        const input = new PassThrough()
        const output = new PassThrough()
        const o = await gate({ interactive: true, offerTimeoutMs: 60, prompter: createReadlinePrompter(input, output) })
        expect(o.result).toBe("returned")
        expect(o.out).toContain("No answer in time")
    })

    it("a closed stdin during the offer aborts the start with 130", async () => {
        writeSubnet(root, "broken", { key: null })
        const input = new PassThrough()
        const output = new PassThrough()
        input.end()
        const o = await gate({ interactive: true, offerTimeoutMs: 5000, prompter: createReadlinePrompter(input, output) })
        expect(o).toMatchObject({ result: "exit", code: 130 })
    })
})

describe("the safety switches fail loudly, not silently", () => {
    it("a mistyped DEMOS_SETUP_STRICT does not pass for 'off' without a word", async () => {
        writeSubnet(root, "broken", { key: null })
        for (const typo of ["ture", "enable", "2"]) {
            const o = await gate({ env: { DEMOS_SETUP_STRICT: typo } })
            expect(o.out).toContain("DEMOS_SETUP_STRICT")
            expect(o.out).toContain(typo)
        }
    })

    it("accepts the spellings the rest of the setup accepts", async () => {
        writeSubnet(root, "broken", { key: null })
        for (const v of ["true", "TRUE", " 1 ", "yes", "on"]) {
            const o = await gate({ env: { DEMOS_SETUP_STRICT: v } })
            expect(o).toMatchObject({ result: "exit", code: 1 })
        }
        for (const v of ["false", "0", "no", "off", ""]) {
            const o = await gate({ env: { DEMOS_SETUP_STRICT: v } })
            expect(o.result).toBe("returned")
        }
    })

    it("strict mode wins over nothing: the skip switch silences the report and strict does not fire", async () => {
        writeSubnet(root, "broken", { key: null })
        const o = await gate({ env: { DEMOS_SKIP_SETUP_CHECK: "true", DEMOS_SETUP_STRICT: "true" }, strict: true })
        expect(o.result).toBe("returned")
        expect(o.out).toBe("")
    })
})

describe("the report and its log", () => {
    it("never prints key material, an env value or the contents of a bad file", async () => {
        const secret = "9f".repeat(31) + "-not-hex-secret"
        writeSubnet(root, "broken", { key: secret })
        const o = await gate({ env: { L2PS_MESSAGING_ENABLED: "true", L2PS_MESSAGING_PORT: "3100" } })
        expect(o.out).toContain("broken")
        expect(o.out + o.logged.join("\n")).not.toContain("9f9f9f")
        expect(o.out + o.logged.join("\n")).not.toContain("not-hex-secret")
    })

    it("a logger that fails changes neither the decision nor the exit code", async () => {
        const failing = async () => {
            throw new Error("disk full")
        }
        writeSubnet(root, "broken", { key: null })
        expect((await gate({ logError: failing })).result).toBe("returned")
        expect(await gate({ logError: failing, strict: true })).toMatchObject({ result: "exit", code: 1 })
        breakIdentity()
        expect(await gate({ logError: failing })).toMatchObject({ result: "exit", code: 1 })
    })

    it("runs the inspection from the node directory it was given, not from wherever the shell is", async () => {
        writeSubnet(root, "broken", { key: null })
        const elsewhere = makeRoot({ identityKey: false })
        try {
            const here = await gate({ cwd: root })
            const there = await gate({ cwd: elsewhere })
            expect(here.out).toContain("broken")
            expect(there).toMatchObject({ result: "exit", code: 1 })
        } finally {
            removeRoot(elsewhere)
        }
    })
})
