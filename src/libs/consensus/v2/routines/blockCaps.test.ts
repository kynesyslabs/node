/**
 * Under `blockCaps` a block takes a bounded share of the merged pool. The
 * choice must be the same on every member holding the same pool, keep each
 * sender's nonces contiguous, and not starve any sender for good.
 */

import { describe, expect, it } from "bun:test"
import {
    blockCapsRefusal,
    selectBlockTransactions,
    txContentBytes,
} from "./blockCaps"
import { orderDeterministically } from "./deterministicOrder"
import { BLOCK_MAX_CONTENT_BYTES, BLOCK_MAX_TXS } from "@/utilities/constants"

const sender = (i: number) => "0x" + i.toString(16).padStart(64, "0")

function tx(from: number, nonce: number, pad = 0) {
    return {
        hash: `0x${from.toString(16).padStart(4, "0")}${nonce.toString(16).padStart(4, "0")}`,
        content: {
            type: "native",
            from: sender(from),
            from_ed25519_address: sender(from),
            nonce,
            pad: "x".repeat(pad),
        },
    } as any
}

/** `senders` senders with `each` consecutive nonces apiece, in block order. */
function pool(senders: number, each: number, pad = 0) {
    const txs = []
    for (let s = 0; s < senders; s++) {
        for (let n = 1; n <= each; n++) txs.push(tx(s, n, pad))
    }
    return orderDeterministically(txs)
}

function noncesBySender(txs: any[]) {
    const out = new Map<string, number[]>()
    for (const t of txs) {
        const list = out.get(t.content.from) ?? []
        list.push(t.content.nonce)
        out.set(t.content.from, list)
    }
    return out
}

describe("selectBlockTransactions", () => {
    it("takes the whole pool when it fits", () => {
        const txs = pool(10, 5)
        expect(selectBlockTransactions(txs, 50, true)).toEqual(txs)
    })

    it("holds a block to the tx cap and leaves the rest pooled", () => {
        const txs = pool(30, 64)
        const block = selectBlockTransactions(txs, 50, true)
        expect(txs.length).toBeGreaterThan(BLOCK_MAX_TXS)
        expect(block).toHaveLength(BLOCK_MAX_TXS)
        // In pool order, and each sender's share is its lowest nonces.
        expect(block).toEqual(txs.filter(t => block.includes(t)))
        for (const nonces of noncesBySender(block).values()) {
            expect(nonces).toEqual(nonces.map((_, i) => i + 1))
        }
    })

    it("holds a block to the content byte cap", () => {
        const txs = pool(40, 2, 64 * 1024)
        const block = selectBlockTransactions(txs, 50, true)
        const bytes = block.reduce((sum, t) => sum + txContentBytes(t, true), 0)
        expect(bytes).toBeLessThanOrEqual(BLOCK_MAX_CONTENT_BYTES)
        expect(block.length).toBeLessThan(txs.length)
        expect(blockCapsRefusal(block, true)).toBeNull()
        for (const nonces of noncesBySender(block).values()) {
            expect(nonces).toEqual(nonces.map((_, i) => i + 1))
        }
    })

    it("selects the same block whatever order the pool was read in", () => {
        const txs = pool(30, 64)
        const shuffled = orderDeterministically([...txs].reverse())
        expect(selectBlockTransactions(shuffled, 77, true).map(t => t.hash)).toEqual(
            selectBlockTransactions(txs, 77, true).map(t => t.hash),
        )
    })

    it("does not favour low addresses: every sender gets in within a few blocks", () => {
        // Twice as many one-tx senders as a block takes.
        const txs = pool(2 * BLOCK_MAX_TXS, 1)
        const included = new Set<string>()
        for (let height = 1; height <= 20; height++) {
            for (const t of selectBlockTransactions(txs, height, true)) {
                included.add(t.content.from)
            }
        }
        expect(included.size).toBe(2 * BLOCK_MAX_TXS)
        // Not simply the lowest addresses, which pool order would give.
        const first = selectBlockTransactions(txs, 1, true)
        expect(first).not.toEqual(txs.slice(0, BLOCK_MAX_TXS))
    })
})

describe("blockCapsRefusal", () => {
    it("refuses a block over either cap and accepts one within both", () => {
        expect(blockCapsRefusal(pool(1, 10), true)).toBeNull()
        expect(blockCapsRefusal(pool(20, 51), true)).toMatch(/over the block cap/)
        expect(
            blockCapsRefusal(pool(2, 1, 3 * 1024 * 1024), true),
        ).toMatch(/bytes of tx content/)
    })
})
