import { describe, expect, it } from "bun:test"
import { isAbsolute } from "node:path"
import { TRUSTED_BIN_DIRS, systemBinary } from "./lib/systemBinary"

describe("systemBinary", () => {
    it("resolves a tool to an absolute path inside a trusted directory", () => {
        const sh = systemBinary("sh")
        expect(isAbsolute(sh)).toBe(true)
        expect(TRUSTED_BIN_DIRS.some(dir => sh === `${dir}/sh`)).toBe(true)
    })

    it("throws instead of falling back to PATH for a missing tool", () => {
        expect(() => systemBinary("no-such-drill-tool-7f3a")).toThrow(/not found/)
    })
})
