import { describe, expect, it } from "bun:test"
import { assembleBlockTxs, missingHashes } from "./blockTxAssembly"

const tx = (hash: string, blockNumber = 0) => ({ hash, blockNumber }) as any

describe("blockTxAssembly", () => {
    it("lists hashes the mempool does not hold", () => {
        expect(missingHashes(["a", "b", "c"], [tx("b")])).toEqual(["a", "c"])
        expect(missingHashes(["a"], [tx("a")])).toEqual([])
        expect(missingHashes([], [])).toEqual([])
    })

    it("restores block order from mixed sources", () => {
        const out = assembleBlockTxs(
            ["a", "b", "c"],
            [tx("c", 0)],
            [tx("a", 7), tx("b", 7)],
            7,
        )
        expect(out.map(t => t.hash)).toEqual(["a", "b", "c"])
    })

    it("retags mempool rows to the block being applied", () => {
        const out = assembleBlockTxs(["a"], [tx("a", 3)], [], 9)
        expect(out[0].blockNumber).toBe(9)
    })

    it("prefers the fetched body when both sources have a hash", () => {
        const out = assembleBlockTxs(["a"], [tx("a", 1)], [tx("a", 9)], 9)
        expect(out).toHaveLength(1)
        expect(out[0].blockNumber).toBe(9)
    })

    it("omits hashes neither source provides", () => {
        const out = assembleBlockTxs(["a", "b"], [], [tx("b")], 1)
        expect(out.map(t => t.hash)).toEqual(["b"])
    })
})
