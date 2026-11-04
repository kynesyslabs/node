import { describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

import { getMetadataArgsStorage } from "typeorm"
import { Transactions } from "@/model/entities/Transactions"
import {
    admissionRefusal,
    isJsonbStorable,
    isTextStorable,
    transactionRowColumns,
    transactionRowRefusal,
    withStorableText,
} from "./postgresStorable"

const { default: Transaction } = await import("src/libs/blockchain/transaction")

describe("isJsonbStorable", () => {
    it("refuses U+0000 and unpaired surrogates in any string or key, at any depth", () => {
        expect(isJsonbStorable("a\u0000")).toBe(false)
        expect(isJsonbStorable({ a: [1, { b: ["x", "y\u0000"] }] })).toBe(false)
        expect(isJsonbStorable({ a: { ["k\u0000"]: 1 } })).toBe(false)
        expect(isJsonbStorable("\ud800")).toBe(false)
        expect(isJsonbStorable("x\udc00y")).toBe(false)
        expect(isJsonbStorable({ ["\ud800"]: 1 })).toBe(false)
        expect(isJsonbStorable([null, 0, false, "ok", "😀", { a: "\\u0000" }])).toBe(true)
    })

    it("walks a value nested deeper than the call stack", () => {
        let deep: unknown = "\u0000"
        for (let i = 0; i < 200_000; i++) deep = [deep]
        expect(isJsonbStorable(deep)).toBe(false)
    })
})

describe("isTextStorable", () => {
    it("refuses U+0000 only: the driver writes an unpaired surrogate as U+FFFD", () => {
        expect(isTextStorable("a\u0000")).toBe(false)
        expect(isTextStorable("a\ud800")).toBe(true)
        expect(isTextStorable(5)).toBe(true)
    })
})

describe("the transaction row", () => {
    it("lists every column of the entity that is neither json nor jsonb", () => {
        const columns = getMetadataArgsStorage()
            .columns.filter(c => c.target === Transactions)
            .filter(c => !["json", "jsonb"].includes(String(c.options.type)))
            .map(c => c.propertyName)
        // id is generated; signature is stored as JSON.stringify output.
        const expected = columns.filter(c => c !== "id" && c !== "signature").sort()
        expect(Object.keys(transactionRowColumns({})).sort()).toEqual(expected)
    })

    it("refuses U+0000 in a column but not in the json body", () => {
        const tx = (content: Record<string, unknown>) => ({ hash: "h", status: "confirmed", content })
        expect(transactionRowRefusal(tx({ to: "0x" + "ab".repeat(32) + "\u0000" }))).toContain("to")
        expect(transactionRowRefusal(tx({ to: "0xab", data: ["native", { memo: "\u0000", ["\u0000"]: 1 }] }))).toBeNull()
        expect(transactionRowRefusal(tx({ to: "0xab\ud800" }))).toBeNull()
        expect(transactionRowRefusal({ hash: "h\u0000", content: {} })).toContain("hash")
    })
})

describe("withStorableText", () => {
    it("replaces U+0000 and unpaired surrogates in strings and keys, and keeps the rest", () => {
        expect<unknown>(withStorableText({ m: "a\u0000b \\u0000", ["k\ud800"]: ["\udc00", 1, null, "😀"] })).toEqual({
            m: "a�b \\u0000",
            ["k�"]: ["�", 1, null, "😀"],
        })
        const clean = { a: 1 }
        expect(withStorableText(clean)).toBe(clean)
        expect(withStorableText(null)).toBeNull()
    })
})

describe("storage program admission", () => {
    const tx = (payload: Record<string, unknown>): any => ({
        content: {
            type: "storageProgram",
            to: "stor-" + "ab".repeat(20),
            data: ["storageProgram", { operation: "CREATE_STORAGE_PROGRAM", programName: "p", data: { a: 1 }, ...payload }],
        },
    })

    for (const [name, payload] of [
        ["U+0000 in a value", { data: { n: "x\u0000" } }],
        ["an unpaired surrogate in the data", { data: { n: "\ud800" } }],
        ["an unpaired surrogate in the acl", { acl: { mode: "restricted", allowed: ["\ud800"] } }],
        ["an unpaired surrogate in the metadata", { metadata: { title: "\ud800" } }],
        ["an unpaired surrogate as a key", { data: { ["\ud800"]: 1 } }],
    ] as const) {
        it(`refuses ${name}`, () => {
            const refused = Transaction.structured(tx(payload))
            expect(refused.valid).toBe(false)
            expect(refused.message).toContain("cannot contain")
        })
    }

    it("admits the same payload with clean text", () => {
        expect(Transaction.structured(tx({ data: { n: "x", "😀": 1 } })).valid).toBe(true)
        expect(admissionRefusal({ content: { data: "ok" } })).toBeNull()
    })
})
