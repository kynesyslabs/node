/**
 * Unit tests for src/libs/blockchain/genesis/mergeGenesisBalances.ts
 *
 * Covers:
 *  - empty / undefined / null input is a no-op
 *  - non-array input throws
 *  - balance coercion: string, number, bigint
 *  - rejects fractional, NaN, negative balances
 *  - rejects malformed entry shapes
 *  - dedup last-wins on duplicate pubkey
 *  - UPDATE path: existing row → balance overwritten, other fields preserved
 *  - INSERT path: missing row → fresh row with default columns
 *  - mixed batch: counts (updated, inserted, total) are correct
 *
 * Test isolation: no real DB. EntityManager is a hand-rolled mock that
 * tracks rows in a Map and exposes the same `getRepository(GCRMain)`
 * surface mergeGenesisBalances uses (findOne / save / create).
 */

import { describe, it, expect } from "bun:test"

import { mergeGenesisBalances } from "src/libs/blockchain/genesis/mergeGenesisBalances"
import { GCRMain } from "src/model/entities/GCRv2/GCR_Main"

// =============================================================================
// EntityManager mock
// =============================================================================

type Row = Partial<GCRMain> & { pubkey: string; balance: bigint }

function makeMockEm() {
    const rows = new Map<string, Row>()

    const repo = {
        findOne: async (opts: { where: { pubkey: string } }) => {
            return rows.get(opts.where.pubkey) ?? null
        },
        save: async (row: Row) => {
            rows.set(row.pubkey, { ...row })
            return row
        },
        create: (row: Row) => row,
    }

    return {
        em: { getRepository: (_e: unknown) => repo } as any,
        rows,
    }
}

function seed(rows: Map<string, Row>, pubkey: string, extras: Partial<Row> = {}) {
    rows.set(pubkey, {
        pubkey,
        balance: 0n,
        flagged: false,
        flaggedReason: "" as const,
        reviewed: false,
        ...extras,
    } as Row)
}

// =============================================================================
// Tests
// =============================================================================

describe("mergeGenesisBalances", () => {
    it("no-op on undefined", async () => {
        const { em, rows } = makeMockEm()
        const r = await mergeGenesisBalances(em, undefined)
        expect(r).toEqual({ total: 0, updated: 0, inserted: 0 })
        expect(rows.size).toBe(0)
    })

    it("no-op on null", async () => {
        const { em, rows } = makeMockEm()
        const r = await mergeGenesisBalances(em, null)
        expect(r).toEqual({ total: 0, updated: 0, inserted: 0 })
        expect(rows.size).toBe(0)
    })

    it("no-op on empty array", async () => {
        const { em, rows } = makeMockEm()
        const r = await mergeGenesisBalances(em, [])
        expect(r).toEqual({ total: 0, updated: 0, inserted: 0 })
        expect(rows.size).toBe(0)
    })

    it("throws on non-array input", async () => {
        const { em } = makeMockEm()
        await expect(
            mergeGenesisBalances(em, { not: "an array" } as any),
        ).rejects.toThrow(/not an array/)
    })

    it("rejects malformed entry shape", async () => {
        const { em } = makeMockEm()
        await expect(
            mergeGenesisBalances(em, [["0xabc"] as any]),
        ).rejects.toThrow(/not a \[pubkey, balance\] tuple/)
    })

    it("rejects empty pubkey", async () => {
        const { em } = makeMockEm()
        await expect(
            mergeGenesisBalances(em, [["", "100"]]),
        ).rejects.toThrow(/pubkey is not a non-empty string/)
    })

    it("rejects negative balance", async () => {
        const { em } = makeMockEm()
        await expect(
            mergeGenesisBalances(em, [["0xabc", "-1"]]),
        ).rejects.toThrow(/negative balance/)
    })

    it("rejects fractional number balance", async () => {
        const { em } = makeMockEm()
        await expect(
            mergeGenesisBalances(em, [["0xabc", 1.5]]),
        ).rejects.toThrow(/must be a finite integer/)
    })

    it("rejects NaN balance", async () => {
        const { em } = makeMockEm()
        await expect(
            mergeGenesisBalances(em, [["0xabc", NaN]]),
        ).rejects.toThrow(/must be a finite integer/)
    })

    it("rejects unsupported balance type", async () => {
        const { em } = makeMockEm()
        await expect(
            mergeGenesisBalances(em, [["0xabc", { v: 1 } as any]]),
        ).rejects.toThrow(/unsupported balance type/)
    })

    it("coerces string balance to bigint", async () => {
        const { em, rows } = makeMockEm()
        await mergeGenesisBalances(em, [["0xaa00000000000000000000000000000000000000000000000000000000000001", "1000000000000000000"]])
        expect(rows.get("0xaa00000000000000000000000000000000000000000000000000000000000001")?.balance).toBe(1000000000000000000n)
    })

    it("coerces integer number balance to bigint", async () => {
        const { em, rows } = makeMockEm()
        await mergeGenesisBalances(em, [["0xaa00000000000000000000000000000000000000000000000000000000000001", 42]])
        expect(rows.get("0xaa00000000000000000000000000000000000000000000000000000000000001")?.balance).toBe(42n)
    })

    it("preserves bigint balance", async () => {
        const { em, rows } = makeMockEm()
        await mergeGenesisBalances(em, [["0xaa00000000000000000000000000000000000000000000000000000000000001", 99n]])
        expect(rows.get("0xaa00000000000000000000000000000000000000000000000000000000000001")?.balance).toBe(99n)
    })

    it("dedup: last-wins on duplicate pubkey", async () => {
        const { em, rows } = makeMockEm()
        const r = await mergeGenesisBalances(em, [
            ["0xaa00000000000000000000000000000000000000000000000000000000000001", "1"],
            ["0xaa00000000000000000000000000000000000000000000000000000000000001", "999"],
        ])
        expect(r.total).toBe(1)
        expect(rows.get("0xaa00000000000000000000000000000000000000000000000000000000000001")?.balance).toBe(999n)
    })

    it("UPDATE path: existing row → balance overwritten, identity preserved", async () => {
        const { em, rows } = makeMockEm()
        seed(rows, "0xaa00000000000000000000000000000000000000000000000000000000000001", {
            balance: 5n,
            identities: { xm: { ok: true } } as any,
            nonce: 7,
        })
        const r = await mergeGenesisBalances(em, [["0xaa00000000000000000000000000000000000000000000000000000000000001", "1000"]])
        expect(r).toEqual({ total: 1, updated: 1, inserted: 0 })
        const row = rows.get("0xaa00000000000000000000000000000000000000000000000000000000000001")!
        expect(row.balance).toBe(1000n)
        // Snapshot-owned columns left intact
        expect((row.identities as any)?.xm).toEqual({ ok: true })
        expect(row.nonce).toBe(7)
    })

    it("INSERT path: missing row → fresh row with defaults", async () => {
        const { em, rows } = makeMockEm()
        const r = await mergeGenesisBalances(em, [["0xcc00000000000000000000000000000000000000000000000000000000000003", "500"]])
        expect(r).toEqual({ total: 1, updated: 0, inserted: 1 })
        const row = rows.get("0xcc00000000000000000000000000000000000000000000000000000000000003")!
        expect(row.balance).toBe(500n)
        expect(row.flagged).toBe(false)
        expect(row.flaggedReason).toBe("")
        expect(row.reviewed).toBe(false)
        expect(row.nonce).toBe(0)
        expect(row.identities).toEqual({ xm: {}, web2: {}, pqc: {}, ud: [] })
        expect(row.referralInfo?.referralCode).toBeTruthy()
    })

    it("mixed batch: counts updated + inserted correctly", async () => {
        const { em, rows } = makeMockEm()
        seed(rows, "0xaa00000000000000000000000000000000000000000000000000000000000001", { balance: 1n })
        seed(rows, "0xbb00000000000000000000000000000000000000000000000000000000000002", { balance: 2n })
        const r = await mergeGenesisBalances(em, [
            ["0xaa00000000000000000000000000000000000000000000000000000000000001", "100"],
            ["0xbb00000000000000000000000000000000000000000000000000000000000002", "200"],
            ["0xdd00000000000000000000000000000000000000000000000000000000000004", "300"],
            ["0xee00000000000000000000000000000000000000000000000000000000000005", "400"],
        ])
        expect(r).toEqual({ total: 4, updated: 2, inserted: 2 })
        expect(rows.get("0xaa00000000000000000000000000000000000000000000000000000000000001")?.balance).toBe(100n)
        expect(rows.get("0xbb00000000000000000000000000000000000000000000000000000000000002")?.balance).toBe(200n)
        expect(rows.get("0xdd00000000000000000000000000000000000000000000000000000000000004")?.balance).toBe(300n)
        expect(rows.get("0xee00000000000000000000000000000000000000000000000000000000000005")?.balance).toBe(400n)
    })

    it("zero balance still applied (operator intent)", async () => {
        const { em, rows } = makeMockEm()
        seed(rows, "0xaa00000000000000000000000000000000000000000000000000000000000001", { balance: 999n })
        await mergeGenesisBalances(em, [["0xaa00000000000000000000000000000000000000000000000000000000000001", "0"]])
        expect(rows.get("0xaa00000000000000000000000000000000000000000000000000000000000001")?.balance).toBe(0n)
    })
})
