/**
 * Petri Consensus — SpeculativeExecutor delta determinism tests
 *
 * Tests that the delta hashing logic is deterministic:
 * same GCR edits → same canonical hash, regardless of object key order.
 */
import { describe, expect, test } from "bun:test"
import { canonicalJson } from "@/libs/consensus/petri/utils/canonicalJson"
import Hashing from "@/libs/crypto/hashing"

// Replicate the hashing logic from speculativeExecutor without DB deps
function computeDeltaHash(
    gcrEdits: Array<{
        type: string
        operation: string
        account: string
        amount?: number | bigint | string
    }>,
): string {
    const editsForHashing = gcrEdits.map(edit => ({
        type: edit.type,
        operation: edit.operation,
        account: edit.account,
        amount:
            typeof edit.amount === "bigint"
                ? edit.amount.toString()
                : String(edit.amount ?? ""),
    }))

    const canonicalEdits = canonicalJson(editsForHashing)
    return Hashing.sha256(canonicalEdits)
}

describe("SpeculativeExecutor delta determinism", () => {
    test("same edits produce same hash", () => {
        const edits = [
            { type: "balance", operation: "remove", account: "0xsender", amount: 100 },
            { type: "balance", operation: "add", account: "0xrecipient", amount: 90 },
            { type: "nonce", operation: "add", account: "0xsender", amount: 1 },
        ]

        const hash1 = computeDeltaHash(edits)
        const hash2 = computeDeltaHash(edits)
        expect(hash1).toBe(hash2)
    })

    test("key order in edit objects does not affect hash", () => {
        const edits1 = [
            { type: "balance", operation: "remove", account: "0xsender", amount: 100 },
        ]
        const edits2 = [
            { account: "0xsender", amount: 100, operation: "remove", type: "balance" },
        ]

        expect(computeDeltaHash(edits1)).toBe(computeDeltaHash(edits2))
    })

    test("different amounts produce different hashes", () => {
        const edits1 = [
            { type: "balance", operation: "add", account: "0xabc", amount: 100 },
        ]
        const edits2 = [
            { type: "balance", operation: "add", account: "0xabc", amount: 101 },
        ]

        expect(computeDeltaHash(edits1)).not.toBe(computeDeltaHash(edits2))
    })

    test("different accounts produce different hashes", () => {
        const edits1 = [
            { type: "balance", operation: "add", account: "0xabc", amount: 100 },
        ]
        const edits2 = [
            { type: "balance", operation: "add", account: "0xdef", amount: 100 },
        ]

        expect(computeDeltaHash(edits1)).not.toBe(computeDeltaHash(edits2))
    })

    test("edit order matters (different order = different hash)", () => {
        const editsA = [
            { type: "balance", operation: "remove", account: "0xsender", amount: 100 },
            { type: "balance", operation: "add", account: "0xrecv", amount: 90 },
        ]
        const editsB = [
            { type: "balance", operation: "add", account: "0xrecv", amount: 90 },
            { type: "balance", operation: "remove", account: "0xsender", amount: 100 },
        ]

        // Array order is significant — edits applied in sequence
        expect(computeDeltaHash(editsA)).not.toBe(computeDeltaHash(editsB))
    })

    test("BigInt amounts are handled consistently", () => {
        const edits1 = [
            { type: "balance", operation: "add", account: "0xabc", amount: BigInt("1000000000000") },
        ]
        const edits2 = [
            { type: "balance", operation: "add", account: "0xabc", amount: BigInt("1000000000000") },
        ]

        expect(computeDeltaHash(edits1)).toBe(computeDeltaHash(edits2))
    })

    test("BigInt and number produce same hash when value matches", () => {
        // Both should stringify to "100"
        const edits1 = [
            { type: "balance", operation: "add", account: "0xabc", amount: 100 },
        ]
        const edits2 = [
            { type: "balance", operation: "add", account: "0xabc", amount: BigInt(100) },
        ]

        expect(computeDeltaHash(edits1)).toBe(computeDeltaHash(edits2))
    })

    test("empty edits produce a deterministic hash", () => {
        const hash1 = computeDeltaHash([])
        const hash2 = computeDeltaHash([])
        expect(hash1).toBe(hash2)
        expect(hash1.length).toBe(64) // SHA-256 hex
    })

    test("hash output is 64 hex characters (SHA-256)", () => {
        const hash = computeDeltaHash([
            { type: "balance", operation: "add", account: "0x1", amount: 1 },
        ])
        expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })
})
