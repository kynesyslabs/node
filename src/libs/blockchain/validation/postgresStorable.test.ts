import { describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

import { getMetadataArgsStorage } from "typeorm"
import { Transactions } from "@/model/entities/Transactions"
import Block from "@/libs/blockchain/block"
import {
    admissionRefusal,
    blockRowRefusal,
    fitsIndexKey,
    isBigintStorable,
    isJsonbStorable,
    isKeyStorable,
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

    it("refuses U+0000 in an array at any depth: the driver sends an array literal as is", () => {
        expect(isTextStorable(["a", ["b\u0000"]])).toBe(false)
        expect(isTextStorable(["a", ["b"]])).toBe(true)
        // An object goes as JSON.stringify output, which escapes it.
        expect(isTextStorable({ a: "\u0000" })).toBe(true)
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

describe("the l2ps_hashes row of an l2ps_hash_update", () => {
    // Written on block insert for every listed update, failed or not, so a
    // block carrying U+0000 there never committed.
    const update = (payload: Record<string, unknown>) => ({
        hash: "h",
        status: "failed",
        content: { type: "l2ps_hash_update", data: ["l2ps_hash_update", { l2ps_uid: "u", consolidated_hash: "c", transaction_count: 1, ...payload }] },
    })

    it("refuses U+0000 in the uid or the hash", () => {
        expect(transactionRowRefusal(update({ l2ps_uid: "u\u0000" }))).toContain("l2ps_uid")
        expect(transactionRowRefusal(update({ consolidated_hash: "\u0000" }))).toContain("consolidated_hash")
    })

    it("accepts what the projection would store, or does not project", () => {
        expect(transactionRowRefusal(update({}))).toBeNull()
        expect(transactionRowRefusal(update({ l2ps_uid: "u\ud800" }))).toBeNull()
        // Without every field the projection skips it, so nothing is written.
        expect(transactionRowRefusal({ hash: "h", content: { type: "l2ps_hash_update", data: ["l2ps_hash_update", { l2ps_uid: "\u0000" }] } })).toBeNull()
        expect(transactionRowRefusal({ hash: "h", content: { type: "native", data: ["native", { l2ps_uid: "\u0000", consolidated_hash: "c", transaction_count: 1 }] } })).toBeNull()
    })
})

describe("isKeyStorable", () => {
    it("refuses U+0000 and unpaired surrogates, which Postgres would merge into one key", () => {
        expect(isKeyStorable("a\u0000")).toBe(false)
        expect(isKeyStorable("a\ud800")).toBe(false)
        expect(isKeyStorable("a😀")).toBe(true)
        expect(isKeyStorable(5)).toBe(false)
        expect(isKeyStorable(["a"])).toBe(false)
    })
})

describe("isBigintStorable", () => {
    it("takes whole numbers in the int8 range, as the driver sends them", () => {
        for (const ok of [0, -5, 1_760_000_000_000, "9223372036854775807", -(2n ** 63n)]) {
            expect(isBigintStorable(ok)).toBe(true)
        }
        for (const bad of [1.5, 1e21, Number.NaN, "9223372036854775808", "1.0", "", null, "1e3"]) {
            expect(isBigintStorable(bad)).toBe(false)
        }
    })
})

describe("blockRowRefusal", () => {
    it("refuses U+0000 and unpaired surrogates in the columns a peer serves unhashed", () => {
        const block = { proposer: "ab".repeat(32), next_proposer: "cd".repeat(32), status: "confirmed" }
        expect(blockRowRefusal(block)).toBeNull()
        expect(blockRowRefusal({ ...block, proposer: "a\u0000" })).toContain("proposer")
        expect(blockRowRefusal({ ...block, next_proposer: "\udfff" })).toContain("next_proposer")
        expect(blockRowRefusal({ ...block, status: "\u0000" })).toContain("status")
    })

    it("refuses what is not a string: the driver would send null or an array literal", () => {
        const block = { proposer: "ab".repeat(32), next_proposer: "", status: "confirmed" }
        expect(blockRowRefusal(block)).toBeNull()
        expect(blockRowRefusal({ ...block, proposer: ["\u0000"] })).toContain("proposer")
        expect(blockRowRefusal({ ...block, proposer: null })).toContain("proposer")
        expect(blockRowRefusal({ ...block, next_proposer: undefined })).toContain("next_proposer")
        expect(blockRowRefusal({ ...block, status: { s: 1 } })).toContain("status")
    })

    it("accepts a block as the node makes it: no status yet, the insert writes one", () => {
        const block = new Block()
        block.proposer = "ab".repeat(32)
        block.next_proposer = "cd".repeat(32)

        expect(block.status).toBeNull()
        expect(blockRowRefusal(block)).toBeNull()
        expect(blockRowRefusal({ ...block, status: undefined })).toBeNull()
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

/** Text no compression shrinks: a b-tree entry keeps about its length. */
const random = (length: number) =>
    Array.from({ length }, (_, i) => String.fromCharCode(0x21 + ((i * 7919 + 13) % 89))).join("")

const ACCOUNT = "0x" + "ab".repeat(32)

describe("fitsIndexKey", () => {
    it("measures a string in UTF-8, as the driver sends it", () => {
        expect(fitsIndexKey("a".repeat(1024))).toBe(true)
        expect(fitsIndexKey("a".repeat(1025))).toBe(false)
        expect(fitsIndexKey("€".repeat(341))).toBe(true)
        expect(fitsIndexKey("€".repeat(342))).toBe(false)
        expect(fitsIndexKey("😀".repeat(256))).toBe(true)
        expect(fitsIndexKey("😀".repeat(257))).toBe(false)
        // An unpaired surrogate goes as U+FFFD, three bytes.
        expect(fitsIndexKey("\ud800".repeat(341))).toBe(true)
        expect(fitsIndexKey("\ud800".repeat(342))).toBe(false)
        expect(fitsIndexKey("abc", 2)).toBe(false)
    })

    it("judges other values by their text", () => {
        for (const short of [null, undefined, 5, true, 10n, ["a"], { a: 1 }]) expect(fitsIndexKey(short)).toBe(true)
        expect(fitsIndexKey(["a".repeat(1100)])).toBe(false)
        expect(fitsIndexKey({ k: "a".repeat(1100) })).toBe(false)
    })
})

describe("the recipient at admission", () => {
    const tx = (to: unknown): any => ({ content: { type: "native", to, data: ["native", {}] } })

    it("takes 0x and 64 hex digits, as clients write an account", () => {
        expect(Transaction.structured(tx(ACCOUNT)).valid).toBe(true)
        expect(Transaction.structured(tx(ACCOUNT.toUpperCase().replace("0X", "0x"))).valid).toBe(true)
    })

    for (const [name, to] of [
        ["64 hex digits followed by text an index cannot hold", ACCOUNT + "Z" + random(3000)],
        ["64 hex digits followed by anything", ACCOUNT + "Z"],
        ["64 hex digits without 0x", "ab".repeat(32)],
        ["a Buffer as JSON", { type: "Buffer", data: Array(32).fill(1) }],
        ["a Buffer as JSON whose bytes are long strings", { type: "Buffer", data: [random(3000), ...Array(31).fill(1)] }],
        ["63 hex digits", ACCOUNT.slice(0, -1)],
    ] as const) {
        it(`refuses ${name}`, () => {
            expect(Transaction.structured(tx(to)).valid).toBe(false)
        })
    }
})

describe("indexed columns of the transaction row", () => {
    const tx = (content: Record<string, unknown>): any => ({
        hash: "cd".repeat(32),
        content: { type: "native", from: ACCOUNT, from_ed25519_address: ACCOUNT, to: ACCOUNT, ...content },
    })

    it("pass at the lengths clients and nodes write", () => {
        expect(transactionRowRefusal(tx({}))).toBeNull()
        // Spellings the node admitted before still pass: blocks carrying them committed.
        expect(transactionRowRefusal(tx({ to: "ab".repeat(32) }))).toBeNull()
        expect(transactionRowRefusal(tx({ to: "" }))).toBeNull()
    })

    for (const [name, content, column] of [
        ["a recipient too long for its index", { to: ACCOUNT + "Z" + random(3000) }, "to"],
        ["an ed25519 address too long for its index", { from_ed25519_address: random(3000) }, "from_ed25519_address"],
        ["a relay sender too long for gcr_assigned_txs", { from_ed25519_address: "", from: random(3904) }, "sender"],
    ] as const) {
        it(`refuse ${name}`, () => {
            expect(transactionRowRefusal(tx(content))).toContain(column)
        })
    }
})
