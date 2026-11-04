/**
 * The granular storage operations run in consensus on a cached entity that the
 * simulate path and the block's later transactions share, so beyond doing the
 * write they must leave that entity untouched when simulating or refusing, and
 * never store a reference into the transaction that carried the value.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
    },
}))

import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import {
    GCRStorageProgramRoutines,
    granularWriteFee,
} from "./GCRStorageProgramRoutines"

const OWNER = "0x" + "aa".repeat(32)
const WRITER = "0x" + "bb".repeat(32)
const STRANGER = "0x" + "cc".repeat(32)
const ADDRESS = "stor-" + "ab".repeat(20)
const MAX = 1048576

function program(overrides: Partial<GCRStorageProgram> = {}): GCRStorageProgram {
    const p = new GCRStorageProgram()
    p.storageAddress = ADDRESS
    p.owner = OWNER
    p.programName = "probe"
    p.encoding = "json"
    p.data = { n: 1, list: ["a", "b", "c"] }
    p.sizeBytes = Buffer.byteLength(JSON.stringify(p.data))
    p.acl = { mode: "owner" }
    p.metadata = null
    p.storageLocation = "onchain"
    p.ipfsCid = null
    p.salt = null
    p.createdByTx = "tx_create"
    p.lastModifiedByTx = "tx_create"
    p.interactionTxs = ["tx_create"]
    p.totalFeesPaid = 1n
    p.isDeleted = false
    p.deletedByTx = null
    return Object.assign(p, overrides)
}

function edit(
    operation: string,
    variables: Record<string, unknown>,
    options: { sender?: string; txhash?: string; isRollback?: boolean } = {},
): any {
    return {
        type: "storageProgram",
        target: ADDRESS,
        isRollback: options.isRollback ?? false,
        txhash: options.txhash ?? "tx_1",
        context: {
            operation,
            sender: options.sender ?? OWNER,
            data: {
                variables: { operation, storageAddress: ADDRESS, ...variables },
                metadata: null,
            },
        },
    }
}

const apply = (e: any, p: GCRStorageProgram | null, simulate = false) =>
    GCRStorageProgramRoutines.apply(e, p, simulate)

const snapshot = (p: GCRStorageProgram) => structuredClone({ ...p })

const writes: [string, Record<string, unknown>][] = [
    ["SET_FIELD", { field: "n", value: 2 }],
    ["SET_ITEM", { field: "list", index: 0, value: "z" }],
    ["APPEND_ITEM", { field: "list", value: "d" }],
]
const removals: [string, Record<string, unknown>][] = [
    ["DELETE_FIELD", { field: "n" }],
    ["DELETE_ITEM", { field: "list", index: 1 }],
]
const all = [...writes, ...removals]

describe("granular storage operations", () => {
    let p: GCRStorageProgram
    beforeEach(() => {
        p = program()
    })

    it("each operation changes the data it names", async () => {
        const expected: Record<string, unknown> = {
            SET_FIELD: { n: 2, list: ["a", "b", "c"] },
            SET_ITEM: { n: 1, list: ["z", "b", "c"] },
            APPEND_ITEM: { n: 1, list: ["a", "b", "c", "d"] },
            DELETE_FIELD: { list: ["a", "b", "c"] },
            DELETE_ITEM: { n: 1, list: ["a", "c"] },
        }
        for (const [op, vars] of all) {
            const fresh = program()
            const result = await apply(edit(op, vars), fresh)
            expect(result.success).toBe(true)
            expect(result.storageProgram).toBe(fresh)
            expect(fresh.data).toEqual(expected[op] as any)
        }
    })

    it("records size, last modifier and interaction on success", async () => {
        for (const [op, vars] of all) {
            const fresh = program()
            await apply(edit(op, vars, { txhash: `tx_${op}` }), fresh)
            expect(fresh.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(fresh.data)))
            expect(fresh.lastModifiedByTx).toBe(`tx_${op}`)
            expect(fresh.interactionTxs).toEqual(["tx_create", `tx_${op}`])
        }
    })

    it("caps the interaction record", async () => {
        p.interactionTxs = Array.from({ length: 1000 }, (_, i) => `tx_${i}`)
        await apply(edit("SET_FIELD", { field: "n", value: 3 }, { txhash: "tx_last" }), p)
        expect(p.interactionTxs.length).toBe(1000)
        expect(p.interactionTxs[0]).toBe("tx_1")
        expect(p.interactionTxs.at(-1)).toBe("tx_last")
    })

    it("records the fee the transaction burns, and none for removals", async () => {
        for (const [op, vars] of writes) {
            const fresh = program()
            await apply(edit(op, vars), fresh)
            expect(fresh.totalFeesPaid).toBe(1n + granularWriteFee({ operation: op, ...vars } as any))
            expect(granularWriteFee({ operation: op, ...vars } as any)).toBe(1n)
        }
        for (const [op, vars] of removals) {
            const fresh = program()
            await apply(edit(op, vars), fresh)
            expect(fresh.totalFeesPaid).toBe(1n)
        }
    })

    it("prices a write by its field and value, 1 DEM per started 10KB", async () => {
        // {"k":"<v>"} frames the value with 8 bytes
        const fee = (vars: Record<string, unknown>) =>
            granularWriteFee({ operation: "SET_FIELD", ...vars } as any)
        expect(fee({ field: "k", value: "v".repeat(10240 - 8) })).toBe(1n)
        expect(fee({ field: "k", value: "v".repeat(10240 - 7) })).toBe(2n)
        expect(fee({ field: "k".repeat(30000), value: 0 })).toBe(3n)
        // Rewriting a field with the same value still pays for what it writes
        await apply(edit("SET_FIELD", { field: "k", value: "v".repeat(10240 - 7) }), p)
        await apply(edit("SET_FIELD", { field: "k", value: "v".repeat(10240 - 7) }), p)
        expect(p.totalFeesPaid).toBe(5n)
    })

    it("the fee never undercharges the growth of the stored data", async () => {
        const cases: [string, Record<string, unknown>][] = [
            ["SET_FIELD", { field: "fresh", value: { deep: "x".repeat(20000) } }],
            ["APPEND_ITEM", { field: "newList", value: "y".repeat(10233) }],
            ["APPEND_ITEM", { field: "list", value: "y".repeat(10236) }],
            ["SET_ITEM", { field: "list", index: 2, value: "w".repeat(20470) }],
        ]
        for (const [op, vars] of cases) {
            const fresh = program()
            const before = fresh.sizeBytes
            await apply(edit(op, vars), fresh)
            const grownChunks = BigInt(Math.ceil((fresh.sizeBytes - before) / 10240))
            expect(granularWriteFee({ operation: op, ...vars } as any)).toBeGreaterThanOrEqual(grownChunks)
        }
    })

    it("simulating checks the write and leaves the entity untouched", async () => {
        const cases = [...all, ["APPEND_ITEM", { field: "fresh", value: 1 }] as [string, Record<string, unknown>]]
        for (const [op, vars] of cases) {
            const fresh = program()
            const before = snapshot(fresh)
            const result = await apply(edit(op, vars), fresh, true)
            expect(result.success).toBe(true)
            expect(result.storageProgram).toBeUndefined()
            expect(snapshot(fresh)).toEqual(before)
        }
    })

    it("simulating still refuses what the write would refuse", async () => {
        const result = await apply(
            edit("SET_FIELD", { field: "big", value: "x".repeat(MAX) }),
            p,
            true,
        )
        expect(result.success).toBe(false)
        expect(result.message).toContain("exceeds maximum")
    })

    it("a refused write leaves the entity untouched", async () => {
        const cases: [string, Record<string, unknown>][] = [
            ["SET_FIELD", { field: "big", value: "x".repeat(MAX) }],
            ["SET_ITEM", { field: "list", index: 0, value: "x".repeat(MAX) }],
            ["APPEND_ITEM", { field: "list", value: "x".repeat(MAX) }],
            ["APPEND_ITEM", { field: "fresh", value: "x".repeat(MAX) }],
        ]
        for (const [op, vars] of cases) {
            const fresh = program()
            const before = snapshot(fresh)
            const result = await apply(edit(op, vars), fresh)
            expect(result.success).toBe(false)
            expect(snapshot(fresh)).toEqual(before)
        }
    })

    it("stores a copy of the value, never the transaction's own object", async () => {
        const first = edit("SET_FIELD", { field: "tags", value: ["a"] })
        await apply(first, p)
        await apply(edit("APPEND_ITEM", { field: "tags", value: "b" }), p)
        expect((p.data as any).tags).toEqual(["a", "b"])
        expect(first.context.data.variables.value).toEqual(["a"])

        const item = edit("APPEND_ITEM", { field: "objs", value: { k: 1 } })
        await apply(item, p)
        ;(p.data as any).objs[0].k = 99
        expect(item.context.data.variables.value).toEqual({ k: 1 })
    })

    it("does not change the data object a previous state still holds", async () => {
        const previous = p.data as Record<string, unknown>
        const list = previous.list
        for (const [op, vars] of all) await apply(edit(op, vars), p)
        expect(previous).toEqual({ n: 1, list: ["a", "b", "c"] })
        expect(list).toEqual(["a", "b", "c"])
    })

    it("works on a program created without data", async () => {
        p.data = null
        expect((await apply(edit("SET_FIELD", { field: "n", value: 1 }), p)).success).toBe(true)
        expect(p.data).toEqual({ n: 1 })
        p.data = null
        expect((await apply(edit("APPEND_ITEM", { field: "l", value: 1 }), p)).success).toBe(true)
        expect(p.data).toEqual({ l: [1] })
    })

    it("counts a negative index from the end of the array", async () => {
        await apply(edit("SET_ITEM", { field: "list", index: -1, value: "z" }), p)
        expect((p.data as any).list).toEqual(["a", "b", "z"])
        await apply(edit("DELETE_ITEM", { field: "list", index: -3 }), p)
        expect((p.data as any).list).toEqual(["b", "z"])
    })

    it("refuses an index that is not a whole position in the array", async () => {
        for (const index of [3, -4, 1.5, "0", null]) {
            for (const op of ["SET_ITEM", "DELETE_ITEM"]) {
                const fresh = program()
                const before = snapshot(fresh)
                const result = await apply(edit(op, { field: "list", index, value: "z" }), fresh)
                expect(result.success).toBe(false)
                expect(snapshot(fresh)).toEqual(before)
            }
        }
    })

    it("refuses array operations on a field that is not an array", async () => {
        for (const op of ["SET_ITEM", "APPEND_ITEM", "DELETE_ITEM"]) {
            const result = await apply(edit(op, { field: "n", index: 0, value: 1 }), program())
            expect(result.success).toBe(false)
            expect(result.message).toContain("is not an array")
        }
        // Inherited names are not fields of the data
        const result = await apply(edit("SET_ITEM", { field: "constructor", index: 0, value: 1 }), p)
        expect(result.success).toBe(false)
    })

    it("treats inherited names as absent fields", async () => {
        expect((await apply(edit("DELETE_FIELD", { field: "toString" }), p)).success).toBe(false)
        expect((await apply(edit("APPEND_ITEM", { field: "constructor", value: 1 }), p)).success).toBe(true)
        expect((p.data as any).constructor).toEqual([1])
    })

    it("refuses the __proto__ field name", async () => {
        for (const [op, vars] of all) {
            const result = await apply(edit(op, { ...vars, field: "__proto__" }), program())
            expect(result.success).toBe(false)
            expect(result.message).toContain("reserved")
        }
    })

    it("refuses a missing field name or a write without a value", async () => {
        for (const [op, vars] of all) {
            const result = await apply(edit(op, { ...vars, field: "" }), program())
            expect(result.success).toBe(false)
        }
        for (const [op, vars] of writes) {
            const { value: _, ...withoutValue } = vars
            const result = await apply(edit(op, withoutValue), program())
            expect(result.success).toBe(false)
            expect(result.message).toContain("Value is required")
        }
    })

    it("refuses U+0000 in a field name or value, which jsonb cannot store", async () => {
        const cases: [string, Record<string, unknown>][] = [
            ["SET_FIELD", { field: "a\u0000b", value: 1 }],
            ["SET_FIELD", { field: "n", value: { k: "x\u0000" } }],
            ["SET_FIELD", { field: "n", value: { ["k\u0000"]: 1 } }],
            ["APPEND_ITEM", { field: "list", value: ["\u0000"] }],
            ["SET_ITEM", { field: "list", index: 0, value: "\u0000" }],
        ]
        for (const [op, vars] of cases) {
            const result = await apply(edit(op, vars), program())
            expect(result.success).toBe(false)
            expect(result.message).toContain("U+0000")
        }
    })

    it("refuses a value nested deeper than 64 levels", async () => {
        let deep: unknown = 1
        for (let i = 0; i < 64; i++) deep = { d: deep }
        const result = await apply(edit("SET_FIELD", { field: "n", value: deep }), p)
        expect(result.success).toBe(false)
        expect(result.message).toContain("nesting depth")
    })

    it("refuses the write that would take the data past 1MB", async () => {
        const filler = "x".repeat(MAX - 40)
        p.data = { filler }
        p.sizeBytes = Buffer.byteLength(JSON.stringify(p.data))
        const result = await apply(edit("SET_FIELD", { field: "more", value: "y".repeat(40) }), p)
        expect(result.success).toBe(false)
        expect(result.message).toContain("exceeds maximum")
        expect(p.data).toEqual({ filler })
    })

    it("refuses a deleted, missing or binary program", async () => {
        for (const [op, vars] of all) {
            const deleted = await apply(edit(op, vars), program({ isDeleted: true }))
            expect(deleted.success).toBe(false)
            expect(deleted.message).toContain("has been deleted")

            const missing = await apply(edit(op, vars), null)
            expect(missing.success).toBe(false)
            expect(missing.message).toContain("not found")

            const binary = await apply(
                edit(op, vars),
                program({ encoding: "binary", data: "AAAA" as any, sizeBytes: 3 }),
            )
            expect(binary.success).toBe(false)
            expect(binary.message).toContain("binary encoding")
        }
    })

    it("refuses a program whose JSON data is not an object", async () => {
        for (const [op, vars] of all) {
            const result = await apply(edit(op, vars), program({ data: [1, 2] as any }))
            expect(result.success).toBe(false)
            expect(result.message).toContain("JSON object")
        }
    })

    it("refuses a sender without write permission", async () => {
        const restricted = () =>
            program({
                acl: {
                    mode: "restricted",
                    groups: {
                        editors: { members: [WRITER], permissions: ["write"] },
                        readers: { members: [STRANGER], permissions: ["read"] },
                    },
                },
            })
        for (const [op, vars] of all) {
            const ownerOnly = await apply(edit(op, vars, { sender: STRANGER }), program())
            expect(ownerOnly.success).toBe(false)
            expect(ownerOnly.message).toContain("No permission")

            const publicMode = await apply(
                edit(op, vars, { sender: STRANGER }),
                program({ acl: { mode: "public" } }),
            )
            expect(publicMode.success).toBe(false)

            const reader = await apply(edit(op, vars, { sender: STRANGER }), restricted())
            expect(reader.success).toBe(false)

            const editor = await apply(edit(op, vars, { sender: WRITER }), restricted())
            expect(editor.success).toBe(true)

            const blacklisted = restricted()
            blacklisted.acl.blacklisted = [WRITER]
            expect((await apply(edit(op, vars, { sender: WRITER }), blacklisted)).success).toBe(false)
        }
    })

    it("refuses to roll back, since the edit does not carry the replaced value", async () => {
        for (const [op, vars] of all) {
            const fresh = program()
            const before = snapshot(fresh)
            const result = await apply(edit(op, vars, { isRollback: true }), fresh)
            expect(result.success).toBe(false)
            expect(result.message).toContain("cannot be rolled back")
            expect(snapshot(fresh)).toEqual(before)
        }
    })

    it("gives the same result for the same edits in the same order", async () => {
        const run = async () => {
            const fresh = program()
            for (const [op, vars] of all) await apply(edit(op, vars), fresh)
            await apply(edit("APPEND_ITEM", { field: "z", value: { b: 1, a: 2 } }), fresh)
            return JSON.stringify(snapshot(fresh), (_, v) => (typeof v === "bigint" ? v.toString() : v))
        }
        expect(await run()).toBe(await run())
    })
})
