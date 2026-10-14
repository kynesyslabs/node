import { describe, expect, it } from "bun:test"
import { PassThrough } from "node:stream"
import { ask, confirm, createReadlinePrompter, select, SetupAborted, SetupTimedOut } from "./prompt"
import { recorder, scriptedPrompter } from "./testSupport"

describe("prompt helpers", () => {
    it("uses the default on an empty answer", async () => {
        expect(await ask(scriptedPrompter([""]), "Name", { default: "x" })).toBe("x")
    })

    it("asks again until the answer validates and shows why", async () => {
        const r = recorder()
        const p = scriptedPrompter(["bad", "good"])
        const v = await ask(p, "Id", { validate: x => (x === "good" ? null : "nope"), say: r.say })
        expect(v).toBe("good")
        expect(p.asked).toHaveLength(2)
        expect(r.lines).toEqual(["  nope"])
    })

    it("confirms with a default and re-asks on gibberish", async () => {
        const r = recorder()
        expect(await confirm(scriptedPrompter([""]), "Ok?", true, r.say)).toBe(true)
        expect(await confirm(scriptedPrompter([""]), "Ok?", false, r.say)).toBe(false)
        expect(await confirm(scriptedPrompter(["huh", "YES"]), "Ok?", false, r.say)).toBe(true)
        expect(r.lines).toEqual(["  Please answer y or n"])
    })

    it("selects by number, by name or by default", async () => {
        const choices = [{ value: "a" as const, label: "A" }, { value: "b" as const, label: "B" }]
        const r = recorder()
        expect(await select(scriptedPrompter(["2"]), "Pick", choices, "a", r.say)).toBe("b")
        expect(await select(scriptedPrompter(["a"]), "Pick", choices, "b", r.say)).toBe("a")
        expect(await select(scriptedPrompter([""]), "Pick", choices, "b", r.say)).toBe("b")
        expect(await select(scriptedPrompter(["9", "1"]), "Pick", choices, "b", r.say)).toBe("a")
    })
})

describe("the terminal prompter", () => {
    const make = () => {
        const input = new PassThrough()
        const output = new PassThrough()
        return { input, output, p: createReadlinePrompter(input, output) }
    }

    it("returns the typed line", async () => {
        const { input, p } = make()
        const pending = p.readLine("Name: ")
        input.write("hello\n")
        expect(await pending).toBe("hello")
    })

    it("times out with SetupTimedOut when nobody answers", async () => {
        const { p } = make()
        await expect(p.readLine("Run? ", { timeoutMs: 30 })).rejects.toBeInstanceOf(SetupTimedOut)
    })

    it("does not time out when the answer comes in time", async () => {
        const { input, p } = make()
        const pending = p.readLine("Run? ", { timeoutMs: 1000 })
        input.write("y\n")
        expect(await pending).toBe("y")
    })

    it("treats end of input (Ctrl-D, closed terminal) as an abort, not a timeout", async () => {
        const { input, p } = make()
        const pending = p.readLine("Run? ", { timeoutMs: 1000 })
        input.end()
        await expect(pending).rejects.toBeInstanceOf(SetupAborted)
    })

    it("hides a secret: the answer is never echoed", async () => {
        const { input, output, p } = make()
        let echoed = ""
        output.on("data", d => (echoed += d.toString()))
        const pending = p.readLine("Key: ", { secret: true })
        input.write("s3cr3t\n")
        expect(await pending).toBe("s3cr3t")
        expect(echoed).not.toContain("s3cr3t")
    })
})
