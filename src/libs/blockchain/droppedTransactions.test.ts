/**
 * The node-local record of txs that left the mempool without a block taking
 * them (#973): bounded by entry count, oldest first, and never terminal: an
 * entry says only that this node no longer holds the tx, and why.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import type { DropReason } from "./chainTypes"
import {
    DROPPED_TX_LIMIT,
    __clearDroppedTxs,
    getDroppedTx,
    recordDropped,
    recordRefusedForBlock,
} from "./droppedTransactions"

const savedForks = getSharedState.forkConfig
const savedHead = getSharedState.lastBlockNumber
const hash = (i: number) => i.toString(16).padStart(64, "0")

beforeEach(() => {
    __clearDroppedTxs()
    getSharedState.forkConfig = cloneDefaultForkConfig()
    // The deep window is at its final size, the case once claimed terminal.
    getSharedState.forkConfig.referenceBlockRoom10 = { activationHeight: 0 }
    getSharedState.lastBlockNumber = 500
})

afterEach(() => {
    __clearDroppedTxs()
    getSharedState.forkConfig = savedForks
    getSharedState.lastBlockNumber = savedHead
})

describe("no entry is terminal", () => {
    it("carries no final flag, for any reason", () => {
        const reasons: DropReason[] = [
            "expired",
            "reference_block_expired",
            "evicted_fee",
            "evicted_sender_cap",
            "seat_refused",
            "refused_for_block",
        ]
        reasons.forEach((reason, i) => recordDropped([hash(i)], reason, 700))
        for (const [i, reason] of reasons.entries()) {
            expect(getDroppedTx(hash(i))).toEqual({
                reason,
                droppedAtBlock: 700,
                droppedAt: expect.any(Number),
            })
        }
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

    it("are replaced by a later drop for another reason after a reference block expiry", () => {
        recordDropped([hash(1)], "reference_block_expired", 700)
        recordDropped([hash(1)], "refused_for_block", 720)
        expect(getDroppedTx(hash(1))).toMatchObject({ reason: "refused_for_block", droppedAtBlock: 720 })
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
        expect(getDroppedTx(hash(1))).toMatchObject({ reason: "refused_for_block" })
        expect(getDroppedTx(hash(2))).toBeNull()
        expect(getDroppedTx(hash(3))).toBeNull()
    })
})
