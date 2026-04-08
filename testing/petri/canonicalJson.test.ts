/**
 * Petri Consensus — canonicalJson unit tests
 *
 * Validates that canonical JSON serialization is deterministic:
 * same logical data always produces the same string regardless of
 * key insertion order, BigInt representation, or Map iteration order.
 */
import { describe, expect, test } from "bun:test"
import { canonicalJson } from "@/libs/consensus/petri/utils/canonicalJson"

describe("canonicalJson", () => {
    test("sorts object keys deterministically", () => {
        const a = canonicalJson({ z: 1, a: 2, m: 3 })
        const b = canonicalJson({ a: 2, m: 3, z: 1 })
        expect(a).toBe(b)
        // Keys should appear in sorted order
        expect(a).toBe("{\"a\":2,\"m\":3,\"z\":1}")
    })

    test("handles nested objects with sorted keys", () => {
        const a = canonicalJson({ outer: { z: 1, a: 2 }, first: true })
        const b = canonicalJson({ first: true, outer: { a: 2, z: 1 } })
        expect(a).toBe(b)
    })

    test("serializes BigInt with n suffix", () => {
        const result = canonicalJson({ balance: BigInt("1000000000000") })
        expect(result).toBe("{\"balance\":\"1000000000000n\"}")
    })

    test("handles Map as sorted entries", () => {
        const map = new Map<string, number>()
        map.set("z", 3)
        map.set("a", 1)
        map.set("m", 2)
        const result = canonicalJson(map)
        expect(result).toBe("{\"a\":1,\"m\":2,\"z\":3}")
    })

    test("handles Set as sorted array", () => {
        const set = new Set(["c", "a", "b"])
        const result = canonicalJson(set)
        expect(result).toBe("[\"a\",\"b\",\"c\"]")
    })

    test("preserves array order (arrays are ordered)", () => {
        const result = canonicalJson([3, 1, 2])
        expect(result).toBe("[3,1,2]")
    })

    test("handles null and undefined", () => {
        expect(canonicalJson(null)).toBe("null")
        expect(canonicalJson(undefined)).toBeUndefined()
    })

    test("handles empty objects and arrays", () => {
        expect(canonicalJson({})).toBe("{}")
        expect(canonicalJson([])).toBe("[]")
    })

    test("determinism: same GCR-like edits produce same output regardless of key order", () => {
        const edit1 = {
            type: "balance",
            operation: "add",
            account: "0xabc123",
            amount: "500",
        }
        const edit2 = {
            amount: "500",
            account: "0xabc123",
            type: "balance",
            operation: "add",
        }
        expect(canonicalJson(edit1)).toBe(canonicalJson(edit2))
    })

    test("determinism: array of edits with different key orders", () => {
        const edits1 = [
            { type: "balance", operation: "remove", account: "sender", amount: "100" },
            { type: "nonce", operation: "add", account: "sender", amount: "1" },
        ]
        const edits2 = [
            { account: "sender", amount: "100", operation: "remove", type: "balance" },
            { account: "sender", amount: "1", operation: "add", type: "nonce" },
        ]
        expect(canonicalJson(edits1)).toBe(canonicalJson(edits2))
    })

    test("handles strings with special characters", () => {
        const result = canonicalJson({ key: "value with \"quotes\" and \n newlines" })
        expect(typeof result).toBe("string")
        expect(JSON.parse(result).key).toBe("value with \"quotes\" and \n newlines")
    })

    test("handles deeply nested structures", () => {
        const deep = {
            level1: {
                level2: {
                    level3: { z: "deep", a: "also deep" },
                },
            },
        }
        const result = canonicalJson(deep)
        const parsed = JSON.parse(result)
        expect(parsed.level1.level2.level3.a).toBe("also deep")
    })
})
