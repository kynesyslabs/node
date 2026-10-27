import { afterEach, describe, expect, it } from "bun:test"
import { loadConfig } from "./loader"

const KEY = "FORK_SCHEDULE_MISMATCH_POLICY"
const saved = process.env[KEY]

afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
})

describe("FORK_SCHEDULE_MISMATCH_POLICY", () => {
    it("defaults to abstain", () => {
        delete process.env[KEY]
        expect(loadConfig().core.forkScheduleMismatchPolicy).toBe("abstain")
    })

    it("accepts warn in any case", () => {
        process.env[KEY] = "WARN"
        expect(loadConfig().core.forkScheduleMismatchPolicy).toBe("warn")
    })

    it("refuses a value it does not know instead of falling back", () => {
        process.env[KEY] = "abstian"
        expect(() => loadConfig()).toThrow(/FORK_SCHEDULE_MISMATCH_POLICY/)
    })
})
