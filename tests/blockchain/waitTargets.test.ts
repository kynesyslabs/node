import { stillStakedSigners } from "src/libs/blockchain/routines/waitTargets"

const A = "0xAAAA"
const B = "0xbbbb"
const C = "0xcccc"

describe("stillStakedSigners", () => {
    it("drops a signer that left the staked set and never includes self", () => {
        const staked = new Set([A.toLowerCase(), B])
        const out = stillStakedSigners([A, B, C], staked, B)
        expect(out).toEqual({ wait: [A], dropped: [C] })
    })

    it("keeps every signer when all are still staked", () => {
        const staked = new Set([A.toLowerCase(), B, C])
        expect(stillStakedSigners([A, B, C], staked, undefined)).toEqual({ wait: [A, B, C], dropped: [] })
    })

    it("returns nothing to wait for when the only other signer unstaked", () => {
        expect(stillStakedSigners([A, B], new Set([A.toLowerCase()]), A)).toEqual({ wait: [], dropped: [B] })
    })
})
