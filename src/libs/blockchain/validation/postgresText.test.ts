import { describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

import { containsNulCharacter } from "./postgresText"

const { default: Transaction } = await import("src/libs/blockchain/transaction")

describe("containsNulCharacter", () => {
    it("finds U+0000 in any string or key, at any depth", () => {
        expect(containsNulCharacter("a\u0000")).toBe(true)
        expect(containsNulCharacter({ a: [1, { b: ["x", "y\u0000"] }] })).toBe(true)
        expect(containsNulCharacter({ a: { ["k\u0000"]: 1 } })).toBe(true)
        expect(containsNulCharacter([null, 0, false, "ok", { a: "\\u0000" }])).toBe(false)
    })

    it("walks a value nested deeper than the call stack", () => {
        let deep: unknown = "\u0000"
        for (let i = 0; i < 200_000; i++) deep = [deep]
        expect(containsNulCharacter(deep)).toBe(true)
    })
})

describe("storage program admission", () => {
    const tx = (data: unknown): any => ({
        content: { type: "storageProgram", to: "stor-" + "ab".repeat(20), data: ["storageProgram", data] },
    })

    it("refuses a storage payload carrying U+0000 before it is admitted", () => {
        const refused = Transaction.structured(tx({ operation: "SET_FIELD", field: "n", value: "x\u0000" }))
        expect(refused.valid).toBe(false)
        expect(refused.message).toContain("U+0000")
        expect(Transaction.structured(tx({ operation: "SET_FIELD", field: "n", value: "x" })).valid).toBe(true)
    })
})
