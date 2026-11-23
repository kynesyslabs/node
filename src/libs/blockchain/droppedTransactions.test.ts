/**
 * The node-local record of txs that left the mempool without a block taking
 * them (#973): bounded by entry count, oldest first, and `final` only where
 * no node can include the tx any more.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import type { DropReason } from "./chainTypes"
import {
    DROPPED_TX_LIMIT,
    __clearDroppedTxs,
    getDroppedTx,
    isFinalDrop,
    recordDropped,
    recordRefusedForBlock,
} from "./droppedTransactions"

const savedForks = getSharedState.forkConfig
const savedHead = getSharedState.lastBlockNumber
const hash = (i: number) => i.toString(16).padStart(64, "0")

beforeEach(() => {
    __clearDroppedTxs()
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.referenceBlockRoom10 = { activationHeight: 0 }
    getSharedState.lastBlockNumber = 500
})

afterEach(() => {
    __clearDroppedTxs()
    getSharedState.forkConfig = savedForks
    getSharedState.lastBlockNumber = savedHead
})

describe("final", () => {
    it("is true for a reference block behind the deep window once the room is 10", () => {
        recordDropped([hash(1)], "reference_block_expired", 700)
        expect(getDroppedTx(hash(1))).toMatchObject({
            reason: "reference_block_expired",
            final: true,
            droppedAtBlock: 700,
        })
    })

    it("is false for that reason before referenceBlockRoom10, which widens the window once", () => {
        getSharedState.forkConfig.referenceBlockRoom10 = { activationHeight: 1000 }
        expect(isFinalDrop("reference_block_expired", 999)).toBe(false)
        expect(isFinalDrop("reference_block_expired", 1000)).toBe(true)
    })

    it("is false for every reason another node may still include", () => {
        const notFinal: DropReason[] = [
            "expired",
            "evicted_fee",
            "evicted_sender_cap",
            "seat_refused",
            "refused_for_block",
        ]
        expect(notFinal.map(reason => isFinalDrop(reason, 700))).toEqual(notFinal.map(() => false))
    })
})

describe("entries", () => {
    it("default to the node's head and the current time", () => {
        const before = Date.now()
        recordDropped([hash(1)], "evicted_fee")
        const entry = getDroppedTx(hash(1))
        expect(entry?.droppedAtBlock).toBe(500)
        expect(entry?.droppedAt).toBeGreaterThanOrEqual(before)
    })

    it("are found whatever the case of the hash", () => {
        recordDropped(["0xABCDEF"], "expired")
        expect(getDroppedTx("0xabcdef")?.reason).toBe("expired")
    })

    it("are replaced by a later drop of the same tx", () => {
        recordDropped([hash(1)], "evicted_fee", 10)
        recordDropped([hash(1)], "expired", 20)
        expect(getDroppedTx(hash(1))).toMatchObject({ reason: "expired", droppedAtBlock: 20 })
    })

    it("are not replaced once final", () => {
        recordDropped([hash(1)], "reference_block_expired", 10)
        recordDropped([hash(1)], "refused_for_block", 10)
        expect(getDroppedTx(hash(1))).toMatchObject({ reason: "reference_block_expired", final: true })
    })
})

describe("the bound", () => {
    it(`holds at most ${DROPPED_TX_LIMIT} entries and forgets the oldest first`, () => {
        recordDropped(
            Array.from({ length: DROPPED_TX_LIMIT + 2 }, (_, i) => hash(i)),
            "evicted_fee",
        )
        expect(getDroppedTx(hash(0))).toBeNull()
        expect(getDroppedTx(hash(1))).toBeNull()
        expect(getDroppedTx(hash(2))).not.toBeNull()
        expect(getDroppedTx(hash(DROPPED_TX_LIMIT + 1))).not.toBeNull()
    })

    it("counts a re-dropped tx as new", () => {
        recordDropped(Array.from({ length: DROPPED_TX_LIMIT }, (_, i) => hash(i)), "evicted_fee")
        recordDropped([hash(0)], "expired")
        recordDropped([hash(DROPPED_TX_LIMIT)], "expired")
        expect(getDroppedTx(hash(0))?.reason).toBe("expired")
        expect(getDroppedTx(hash(1))).toBeNull()
    })
})

describe("recordRefusedForBlock", () => {
    it("records only the removed txs the block does not carry", () => {
        recordRefusedForBlock([hash(1), hash(2)], [{ hash: hash(2) }, { hash: hash(3) }])
        expect(getDroppedTx(hash(1))).toMatchObject({ reason: "refused_for_block", final: false })
        expect(getDroppedTx(hash(2))).toBeNull()
        expect(getDroppedTx(hash(3))).toBeNull()
    })
})
