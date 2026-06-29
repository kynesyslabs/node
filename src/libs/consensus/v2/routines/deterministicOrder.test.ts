import {
    compareTxDeterministic,
    orderDeterministically,
    senderKey,
} from "./deterministicOrder"
import { Transaction } from "@kynesyslabs/demosdk/types"

/**
 * P-ORDER self-check (Epic #21). Smallest test that fails if the deterministic
 * (sender, nonce, hash) order breaks: determinism across input permutations,
 * per-sender nonce ordering, hash tie-break, and no-mutation.
 */
function tx(from: string, nonce: number, hash: string): Transaction {
    return { content: { from, nonce }, hash } as unknown as Transaction
}

describe("deterministicOrder (P-ORDER)", () => {
    test("sorts by sender then nonce then hash", () => {
        const input = [
            tx("0xbb", 2, "h3"),
            tx("0xaa", 5, "h1"),
            tx("0xaa", 1, "h2"),
            tx("0xbb", 2, "h0"), // same (sender,nonce) -> hash tie-break
        ]
        const out = orderDeterministically(input).map(t => t.hash)
        // 0xaa nonce1, 0xaa nonce5, 0xbb nonce2 (h0 before h3)
        expect(out).toEqual(["h2", "h1", "h0", "h3"])
    })

    test("is permutation-invariant (determinism)", () => {
        const a = tx("0xaa", 1, "h1")
        const b = tx("0xaa", 2, "h2")
        const c = tx("0xbb", 1, "h3")
        const o1 = orderDeterministically([a, b, c]).map(t => t.hash)
        const o2 = orderDeterministically([c, b, a]).map(t => t.hash)
        const o3 = orderDeterministically([b, c, a]).map(t => t.hash)
        expect(o1).toEqual(o2)
        expect(o2).toEqual(o3)
    })

    test("sender key is lowercased", () => {
        expect(senderKey(tx("0xABCDEF", 0, "h"))).toBe("0xabcdef")
    })

    test("does not mutate input", () => {
        const input = [tx("0xbb", 1, "h2"), tx("0xaa", 1, "h1")]
        const snapshot = input.map(t => t.hash)
        orderDeterministically(input)
        expect(input.map(t => t.hash)).toEqual(snapshot)
    })

    test("comparator is a total order (antisymmetry)", () => {
        const x = tx("0xaa", 1, "h1")
        const y = tx("0xbb", 2, "h2")
        expect(Math.sign(compareTxDeterministic(x, y))).toBe(
            -Math.sign(compareTxDeterministic(y, x)),
        )
        expect(compareTxDeterministic(x, x)).toBe(0)
    })
})
