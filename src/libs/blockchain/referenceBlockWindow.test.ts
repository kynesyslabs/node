/**
 * The reference block room, 1 block before `referenceBlockRoom10` and 10
 * from it on, judged at the tip a block is forged on.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import {
    deepWindowCutoff,
    isReferenceBlockAllowed,
    isWithinDeepWindow,
    previousRuleHeights,
    referenceBlockRoomAt,
} from "./referenceBlockWindow"

const saved = getSharedState.forkConfig

beforeEach(() => {
    getSharedState.forkConfig = cloneDefaultForkConfig()
})

afterEach(() => {
    getSharedState.forkConfig = saved
})

const roomFrom = (height: number | null) => {
    getSharedState.forkConfig.referenceBlockRoom10 = { activationHeight: height }
}

describe("referenceBlockRoomAt", () => {
    it("is 1 while the fork is not scheduled, as every chain before it ran", () => {
        expect(referenceBlockRoomAt(0)).toBe(1)
        expect(referenceBlockRoomAt(1_000_000)).toBe(1)
    })

    it("is 10 from the activation height on and 1 below it", () => {
        roomFrom(200)
        expect(referenceBlockRoomAt(199)).toBe(1)
        expect(referenceBlockRoomAt(200)).toBe(10)
        expect(referenceBlockRoomAt(201)).toBe(10)
    })
})

describe("a transaction 5 blocks behind the head", () => {
    const head = 100

    it("is refused before the fork and kept only for inclusion as failed", () => {
        expect(isReferenceBlockAllowed(head - 5, head)).toBe(false)
        expect(isWithinDeepWindow(head - 5, head)).toBe(true)
        expect(isWithinDeepWindow(head - 6, head)).toBe(false)
    })

    it("is allowed after the fork", () => {
        roomFrom(0)
        expect(isReferenceBlockAllowed(head - 5, head)).toBe(true)
        expect(isReferenceBlockAllowed(head - 10, head)).toBe(true)
        expect(isReferenceBlockAllowed(head - 11, head)).toBe(false)
        expect(isReferenceBlockAllowed(head + 1, head)).toBe(false)
    })

    it("has a deep window of five rooms on either side of the fork", () => {
        expect(deepWindowCutoff(head)).toBe(head - 5)
        roomFrom(0)
        expect(deepWindowCutoff(head)).toBe(head - 50)
    })
})

describe("previousRuleHeights", () => {
    it("uses the deep window of the block's own tip", () => {
        getSharedState.forkConfig.osDenomination = { activationHeight: 100 }
        // Room 1: the old rule is accepted for 5 blocks after the fork.
        expect(previousRuleHeights(104)).toEqual([99])
        expect(previousRuleHeights(105)).toEqual([])

        // Room 10 from the tip of block 100 on: 50 blocks.
        roomFrom(99)
        expect(previousRuleHeights(105)).toEqual([99])
        expect(previousRuleHeights(149)).toEqual([99])
        expect(previousRuleHeights(150)).toEqual([])
    })
})
