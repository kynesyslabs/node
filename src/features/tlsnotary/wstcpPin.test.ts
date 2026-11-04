import { describe, expect, it } from "bun:test"
import { hasPinnedWstcp } from "./proxyManager"

describe("hasPinnedWstcp", () => {
    it("accepts the pinned version from cargo's install list", () => {
        expect(hasPinnedWstcp("ripgrep v14.1.0:\n    rg\nwstcp v0.2.1:\n    wstcp\n")).toBe(true)
    })

    it("rejects another version left by an older unpinned install", () => {
        expect(hasPinnedWstcp("wstcp v0.2.0:\n    wstcp\n")).toBe(false)
        expect(hasPinnedWstcp("wstcp v0.2.10:\n    wstcp\n")).toBe(false)
    })

    it("rejects a list without wstcp", () => {
        expect(hasPinnedWstcp("")).toBe(false)
    })
})
