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

let nonceRead: (accounts: string[]) => Promise<Record<string, number>> = async () => ({})
mock.module("@/libs/blockchain/gcr/gcr", () => ({
    default: { getAccountNonces: (accounts: string[]) => nonceRead(accounts) },
}))

const { applyWithSyncedNonceTrace, assertSyncedNonceTrace, readNonceTrace } = await import("./nonceTrace")

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

describe("readNonceTrace", () => {
    const entry = { startFilter: 1, projectedEnd: 2, startApply: 1, endApply: 2 }

    it("returns a well-formed trace", () => {
        expect(readNonceTrace({ nonceTrace: { "0xaa": entry } })).toEqual({ "0xaa": entry })
    })

    it("drops a trace whose fields are not numbers", () => {
        for (const bad of [{ toString: null }, "1", null, 1n]) {
            expect(readNonceTrace({ nonceTrace: { "0xaa": { ...entry, startApply: bad } } })).toBeNull()
            expect(readNonceTrace({ nonceTrace: { "0xaa": { ...entry, endApply: bad } } })).toBeNull()
        }
    })

    it("drops a trace that is not a map of entries", () => {
        for (const bad of [[entry], { "0xaa": null }, { "0xaa": 5 }, "trace"]) {
            expect(readNonceTrace({ nonceTrace: bad })).toBeNull()
        }
    })
})

describe("applyWithSyncedNonceTrace", () => {
    const applied = { pending: undefined, successfulTxs: ["tx"] }

    beforeEach(() => {
        errors.length = 0
        nonceRead = async accounts => Object.fromEntries(accounts.map(a => [a, 1]))
    })

    it("applies when the nonce read refuses a peer-chosen key", async () => {
        nonceRead = async () => {
            throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: "22021" })
        }
        let ran = false
        const out = await applyWithSyncedNonceTrace(15, { "0x\u0000": {} } as never, false, async () => {
            ran = true
            return applied
        })
        expect(ran).toBe(true)
        expect(out).toBe(applied)
    })

    it("applies when the check itself cannot print a field", async () => {
        const trace = { "0xaa": { startApply: { toString: null }, endApply: 1 } } as never
        const out = await applyWithSyncedNonceTrace(16, trace, true, async () => applied)
        expect(out).toBe(applied)
    })

    it("logs a mismatch read after a committed apply", async () => {
        const trace = { "0xaa": { startFilter: 0, projectedEnd: 3, startApply: 1, endApply: 3 } }
        const out = await applyWithSyncedNonceTrace(17, trace, false, async () => applied)
        expect(out).toBe(applied)
        expect(errors.some(e => e.includes("nonce trace mismatch on block 17"))).toBe(true)
    })
})
