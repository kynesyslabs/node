import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

const errors: string[] = []
mock.module("src/utilities/logger", () => ({
    default: {
        error: (msg: string) => errors.push(msg),
        warn: () => {},
        warning: () => {},
        info: () => {},
        debug: () => {},
    },
}))

const { assertSyncedNonceTrace } = await import("./nonceTrace")

// The trace a syncing node checks comes from the block's attrs, outside the
// block hash, so whoever served the block wrote it.
describe("assertSyncedNonceTrace", () => {
    let exit: ReturnType<typeof spyOn>

    beforeEach(() => {
        errors.length = 0
        exit = spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process.exit called")
        }) as never)
    })

    afterEach(() => {
        exit.mockRestore()
    })

    it("logs a mismatching trace and keeps the node running", () => {
        const trace = {
            "0xaa": { startFilter: 0, projectedEnd: 9, startApply: 7, endApply: 9 },
        }
        expect(() => assertSyncedNonceTrace(12, trace, { "0xaa": 1 }, { "0xaa": 2 })).not.toThrow()
        expect(exit).not.toHaveBeenCalled()
        expect(errors.some(e => e.includes("nonce trace mismatch on block 12"))).toBe(true)
    })

    it("does not throw on a malformed entry", () => {
        const trace = { "0xaa": null } as never
        expect(() => assertSyncedNonceTrace(13, trace, { "0xaa": 1 }, { "0xaa": 1 })).not.toThrow()
        expect(exit).not.toHaveBeenCalled()
        expect(errors.length).toBeGreaterThan(0)
    })

    it("stays quiet when the trace matches", () => {
        const trace = {
            "0xaa": { startFilter: 1, projectedEnd: 2, startApply: 1, endApply: 2 },
        }
        assertSyncedNonceTrace(14, trace, { "0xaa": 1 }, { "0xaa": 2 })
        expect(errors).toEqual([])
    })
})
