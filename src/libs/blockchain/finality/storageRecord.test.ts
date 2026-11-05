import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
    storageProgramKey,
    storageProgramLeafHex,
    storageProgramRecord,
    type StorageProgramRow,
} from "./storageRecord"

const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex")

function row(overrides: Partial<StorageProgramRow> = {}): StorageProgramRow {
    return {
        storageAddress: "stor-0123456789abcdef0123456789abcdef01234567",
        owner: "0xaa",
        programName: "notes",
        encoding: "json",
        data: { b: 1, a: [true, null, "x"] },
        sizeBytes: 27,
        acl: { mode: "owner" },
        metadata: null,
        createdByTx: "0xc1",
        lastModifiedByTx: "0xc2",
        isDeleted: false,
        ...overrides,
    }
}

describe("storage program record", () => {
    it("matches the published test vector", () => {
        // A client verifier reproduces exactly this text and these hashes.
        const record = storageProgramRecord(row())
        const text = [
            "{\"aclHash\":\"" + sha256Hex("{\"mode\":\"owner\"}") + "\"",
            "\"createdByTx\":\"0xc1\"",
            "\"dataHash\":\"" + sha256Hex("{\"a\":[true,null,\"x\"],\"b\":1}") + "\"",
            "\"encoding\":\"json\"",
            "\"isDeleted\":false",
            "\"lastModifiedByTx\":\"0xc2\"",
            "\"metadataHash\":\"" + sha256Hex("null") + "\"",
            "\"owner\":\"0xaa\"",
            "\"programName\":\"notes\"",
            "\"sizeBytes\":27",
            "\"storageAddress\":\"stor-0123456789abcdef0123456789abcdef01234567\"}",
        ].join(",")
        expect(Object.keys(record).sort()).toEqual([
            "aclHash",
            "createdByTx",
            "dataHash",
            "encoding",
            "isDeleted",
            "lastModifiedByTx",
            "metadataHash",
            "owner",
            "programName",
            "sizeBytes",
            "storageAddress",
        ])
        const leaf = sha256Hex(Buffer.concat([Buffer.from([0x00]), Buffer.from(text, "utf8")]))
        expect(storageProgramLeafHex(row())).toBe(leaf)
        expect(leaf).toBe("0ebbe889975321d3889efaeec9837dbb62fa90bef9d268c416ee1de4c018707f")
        expect(Buffer.from(storageProgramKey(row().storageAddress)).toString("hex")).toBe(
            sha256Hex(row().storageAddress),
        )
    })

    it("does not depend on key order, at any depth", () => {
        const a = row({ data: { x: { p: 1, q: [1, { s: 2, r: 3 }] }, y: "z" }, acl: { mode: "public", allowed: ["b"] } })
        const b = row({ data: { y: "z", x: { q: [1, { r: 3, s: 2 }], p: 1 } }, acl: { allowed: ["b"], mode: "public" } })
        expect(storageProgramLeafHex(a)).toBe(storageProgramLeafHex(b))
        // Array order is data, not layout.
        const c = row({ data: { y: "z", x: { q: [{ r: 3, s: 2 }, 1], p: 1 } }, acl: a.acl })
        expect(storageProgramLeafHex(c)).not.toBe(storageProgramLeafHex(a))
    })

    it("spells numbers as JSON does, floats included", () => {
        const leaf = (data: unknown) => storageProgramLeafHex(row({ data }))
        expect(leaf({ n: 0.1 + 0.2 })).not.toBe(leaf({ n: 0.3 }))
        expect(leaf({ n: 1.0 })).toBe(leaf({ n: 1 }))
        expect(leaf({ n: -0 })).toBe(leaf({ n: 0 }))
        expect(leaf({ n: 1e21 })).toBe(leaf({ n: 1000000000000000000000 }))
        expect(storageProgramRecord(row({ data: { n: 1.5e-7 } })).dataHash).toBe(sha256Hex("{\"n\":1.5e-7}"))
    })

    it("does not normalize Unicode", () => {
        const composed = row({ data: { name: "café" }, programName: "é" })
        const decomposed = row({ data: { name: "café" }, programName: "é" })
        expect(storageProgramLeafHex(composed)).not.toBe(storageProgramLeafHex(decomposed))
        expect(storageProgramRecord(row({ data: { k: "日本" } })).dataHash).toBe(sha256Hex("{\"k\":\"日本\"}"))
    })

    it("takes text columns as Postgres stores them", () => {
        // UTF-8 has no lone surrogate; the column reads back U+FFFD.
        expect(storageProgramLeafHex(row({ programName: "a\ud800" }))).toBe(
            storageProgramLeafHex(row({ programName: "a�" })),
        )
    })

    it("hashes a binary program's stored base64 text, and keeps the encoding apart", () => {
        const base64 = Buffer.from([0, 1, 2, 250]).toString("base64")
        const binary = row({ encoding: "binary", data: base64, sizeBytes: 4 })
        expect(storageProgramRecord(binary).dataHash).toBe(sha256Hex(JSON.stringify(base64)))
        const json = row({ encoding: "json", data: base64, sizeBytes: 4 })
        expect(storageProgramLeafHex(binary)).not.toBe(storageProgramLeafHex(json))
    })

    it("gives a row being written the leaf of the same row read back from jsonb", () => {
        const written = row({
            data: { at: new Date("2026-11-04T00:00:00.000Z"), gone: undefined, list: [undefined, 1] },
            metadata: { note: "x", skip: undefined },
            isDeleted: undefined,
        })
        const readBack = row({
            data: { at: "2026-11-04T00:00:00.000Z", list: [null, 1] },
            metadata: { note: "x" },
            isDeleted: false,
        })
        expect(storageProgramLeafHex(written)).toBe(storageProgramLeafHex(readBack))
        expect(storageProgramLeafHex(row({ data: undefined }))).toBe(storageProgramLeafHex(row({ data: null })))
    })

    it("changes with every committed field and with nothing else", () => {
        const base = storageProgramLeafHex(row())
        const changes: Partial<StorageProgramRow>[] = [
            { storageAddress: "stor-other" },
            { owner: "0xbb" },
            { programName: "other" },
            { encoding: "binary" },
            { data: { b: 2, a: [true, null, "x"] } },
            { sizeBytes: 28 },
            { acl: { mode: "public" } },
            { metadata: {} },
            { createdByTx: "0xd1" },
            { lastModifiedByTx: "0xd2" },
            { isDeleted: true },
        ]
        for (const change of changes) {
            expect(storageProgramLeafHex(row(change))).not.toBe(base)
        }
        const extra = { ...row(), createdAt: new Date(), updatedAt: new Date(), totalFeesPaid: 5n, smtLeaf: "ff" }
        expect(storageProgramLeafHex(extra)).toBe(base)
    })

    it("refuses a row with no JSON spelling rather than guessing one", () => {
        expect(() => storageProgramLeafHex(row({ sizeBytes: Number.NaN }))).toThrow()
        expect(() => storageProgramLeafHex(row({ data: { big: 1n } }))).toThrow()
    })
})
