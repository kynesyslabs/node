import { describe, expect, it } from "bun:test"
import { ask, confirm, select } from "./prompt"
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
