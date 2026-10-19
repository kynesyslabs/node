import { describe, expect, it } from "bun:test"
import { estimateConfirmationBlock } from "./confirmationEstimate"

const base = { lastBlockNumber: 100, lastBlockTimestamp: 1000, blockTime: 10, inConsensusLoop: false }

describe("estimateConfirmationBlock", () => {
    it("targets the next block early in the interval", () => {
        expect(estimateConfirmationBlock({ ...base, now: 1000 })).toBe(101)
        expect(estimateConfirmationBlock({ ...base, now: 1006 })).toBe(101)
    })

    it("targets the block after next from two thirds of the interval", () => {
        expect(estimateConfirmationBlock({ ...base, now: 1007 })).toBe(102)
        expect(estimateConfirmationBlock({ ...base, now: 1030 })).toBe(102)
    })

    it("targets the block after next while a round is running", () => {
        expect(estimateConfirmationBlock({ ...base, now: 1001, inConsensusLoop: true })).toBe(102)
    })

    it("tolerates clock skew that puts now before the last block", () => {
        expect(estimateConfirmationBlock({ ...base, now: 990 })).toBe(101)
    })
})
