import { afterEach, describe, expect, it } from "bun:test"
import { loadConfig } from "./loader"

const KEY = "FORK_SCHEDULE_MISMATCH_POLICY"
const REQUIRE = "DEMOS_REQUIRE_VALIDATORS"
const saved = process.env[KEY]
const savedRequire = process.env[REQUIRE]

afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
    if (savedRequire === undefined) delete process.env[REQUIRE]
    else process.env[REQUIRE] = savedRequire
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

    it("refuses warn on a mainnet validator, and allows abstain there", () => {
        process.env[REQUIRE] = "true"
        process.env[KEY] = "Warn"
        expect(() => loadConfig()).toThrow(/devnets and testnets/)
        process.env[KEY] = "abstain"
        expect(loadConfig().core.forkScheduleMismatchPolicy).toBe("abstain")
        delete process.env[KEY]
        expect(loadConfig().core.forkScheduleMismatchPolicy).toBe("abstain")
    })

    it("keeps warn on a node that does not require validators", () => {
        process.env[KEY] = "warn"
        for (const v of [undefined, "", "false", "TRUE"]) {
            if (v === undefined) delete process.env[REQUIRE]
            else process.env[REQUIRE] = v
            expect(loadConfig().core.forkScheduleMismatchPolicy).toBe("warn")
        }
    })

    it("refuses a value it does not know instead of falling back", () => {
        process.env[KEY] = "abstian"
        expect(() => loadConfig()).toThrow(/FORK_SCHEDULE_MISMATCH_POLICY/)
    })
})
