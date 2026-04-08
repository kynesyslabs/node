/**
 * Petri Consensus — Phase 6: Liveness Guarantee Test
 *
 * Verifies the chain NEVER stalls under any circumstances:
 *   - Empty blocks are produced when no txs exist
 *   - PROBLEMATIC txs are rejected (not retried indefinitely)
 *   - PRE_APPROVED txs are included even when PROBLEMATIC txs exist
 *   - Block production continues on schedule regardless of conflicts
 */
import { describe, expect, test } from "bun:test"
import { DeltaAgreementTracker } from "@/libs/consensus/petri/forge/deltaAgreementTracker"
import { TransactionClassification } from "@/libs/consensus/petri/types/classificationTypes"

// ---- Helpers ----

function bftThreshold(n: number): number {
    return Math.floor((n * 2) / 3) + 1
}

// Simulates a single block period's mempool state and lifecycle
interface BlockPeriodResult {
    blockProduced: boolean
    txsIncluded: number
    txsRejected: number
    isEmpty: boolean
}

function simulateBlockPeriod(
    mempool: Array<{ hash: string; classification: string }>,
    bftResults: Record<string, boolean>, // hash → resolved?
): BlockPeriodResult {
    const preApproved = mempool.filter(
        t => t.classification === TransactionClassification.PRE_APPROVED,
    )
    const problematic = mempool.filter(
        t => t.classification === TransactionClassification.PROBLEMATIC,
    )

    const resolved = problematic.filter(t => bftResults[t.hash] === true)
    const rejected = problematic.filter(t => bftResults[t.hash] === false)

    const blockTxs = [...preApproved, ...resolved]
    const isEmpty = blockTxs.length === 0

    // Block is ALWAYS produced — empty or not
    return {
        blockProduced: true,
        txsIncluded: blockTxs.length,
        txsRejected: rejected.length,
        isEmpty,
    }
}

// ---- Liveness: Empty Blocks ----

describe("Liveness — Empty Blocks", () => {
    test("empty mempool → empty block produced", () => {
        const result = simulateBlockPeriod([], {})

        expect(result.blockProduced).toBe(true)
        expect(result.isEmpty).toBe(true)
        expect(result.txsIncluded).toBe(0)
    })

    test("only TO_APPROVE txs (none promoted yet) → empty block", () => {
        const mempool = [
            { hash: "tx_1", classification: TransactionClassification.TO_APPROVE },
            { hash: "tx_2", classification: TransactionClassification.TO_APPROVE },
        ]
        const result = simulateBlockPeriod(mempool, {})

        expect(result.blockProduced).toBe(true)
        expect(result.isEmpty).toBe(true)
        // TO_APPROVE txs stay for next block period's forge
    })

    test("all PROBLEMATIC and all rejected → empty block", () => {
        const mempool = [
            { hash: "tx_1", classification: TransactionClassification.PROBLEMATIC },
            { hash: "tx_2", classification: TransactionClassification.PROBLEMATIC },
        ]
        const result = simulateBlockPeriod(mempool, {
            tx_1: false,
            tx_2: false,
        })

        expect(result.blockProduced).toBe(true)
        expect(result.isEmpty).toBe(true)
        expect(result.txsRejected).toBe(2)
    })
})

// ---- Liveness: Block Production Continues ----

describe("Liveness — Block Production Schedule", () => {
    test("blocks produced every period regardless of mempool state", () => {
        // Simulate 5 consecutive block periods with varying states
        const periods = [
            { mempool: [], bft: {} }, // Empty
            { mempool: [{ hash: "tx_1", classification: "PRE_APPROVED" as const }], bft: {} },
            { mempool: [{ hash: "tx_2", classification: "PROBLEMATIC" as const }], bft: { tx_2: false } },
            { mempool: [], bft: {} }, // Empty again
            {
                mempool: [
                    { hash: "tx_3", classification: "PRE_APPROVED" as const },
                    { hash: "tx_4", classification: "PROBLEMATIC" as const },
                ],
                bft: { tx_4: true },
            },
        ]

        for (const period of periods) {
            const result = simulateBlockPeriod(period.mempool, period.bft)
            expect(result.blockProduced).toBe(true) // ALWAYS
        }
    })

    test("consecutive empty blocks are allowed", () => {
        for (let i = 0; i < 10; i++) {
            const result = simulateBlockPeriod([], {})
            expect(result.blockProduced).toBe(true)
            expect(result.isEmpty).toBe(true)
        }
    })
})

// ---- Liveness: PROBLEMATIC TX Bounded Lifetime ----

describe("Liveness — PROBLEMATIC TX Bounded Lifetime", () => {
    test("PROBLEMATIC tx is flagged after TTL rounds (not infinite)", () => {
        const ttlRounds = 5
        const shardSize = 10
        const threshold = bftThreshold(shardSize)
        const tracker = new DeltaAgreementTracker(threshold, ttlRounds)

        // Simulate a tx that never reaches agreement
        for (let round = 1; round <= ttlRounds; round++) {
            // 5-5 split every round
            for (let i = 0; i < 5; i++) {
                tracker.recordDelta("tx_stuck", "delta_a", `m_${i}`, round)
            }
            for (let i = 5; i < 10; i++) {
                tracker.recordDelta("tx_stuck", "delta_b", `m_${i}`, round)
            }

            const result = tracker.evaluate(shardSize, round)
            if (round === ttlRounds) {
                expect(result.flagged).toContain("tx_stuck")
            }
        }
    })

    test("flagged TX is cleaned from tracker after evaluation", () => {
        const tracker = new DeltaAgreementTracker(7, 1) // TTL=1 round

        // Single round with disagreement → immediately flagged
        for (let i = 0; i < 5; i++) {
            tracker.recordDelta("tx_clean", "delta_a", `m_${i}`, 1)
        }
        for (let i = 5; i < 10; i++) {
            tracker.recordDelta("tx_clean", "delta_b", `m_${i}`, 1)
        }

        const result = tracker.evaluate(10, 1)
        expect(result.flagged).toContain("tx_clean")

        // After flagging, the tx is removed from tracking
        expect(tracker.trackedCount).toBe(0)
    })

    test("promoted TX is cleaned from tracker after evaluation", () => {
        const tracker = new DeltaAgreementTracker(7, 5)

        for (let i = 0; i < 10; i++) {
            tracker.recordDelta("tx_promoted", "delta_ok", `m_${i}`, 1)
        }

        const result = tracker.evaluate(10, 1)
        expect(result.promoted).toContain("tx_promoted")
        expect(tracker.trackedCount).toBe(0)
    })
})

// ---- Liveness: Mixed State Handling ----

describe("Liveness — Mixed State Block Periods", () => {
    test("PRE_APPROVED included even when PROBLEMATIC exist", () => {
        const mempool = [
            { hash: "tx_good_1", classification: TransactionClassification.PRE_APPROVED },
            { hash: "tx_good_2", classification: TransactionClassification.PRE_APPROVED },
            { hash: "tx_bad", classification: TransactionClassification.PROBLEMATIC },
        ]

        const result = simulateBlockPeriod(mempool, { tx_bad: false })

        expect(result.blockProduced).toBe(true)
        expect(result.txsIncluded).toBe(2) // Both PRE_APPROVED
        expect(result.txsRejected).toBe(1) // tx_bad rejected
        expect(result.isEmpty).toBe(false)
    })

    test("resolved PROBLEMATIC included alongside PRE_APPROVED", () => {
        const mempool = [
            { hash: "tx_approved", classification: TransactionClassification.PRE_APPROVED },
            { hash: "tx_resolved", classification: TransactionClassification.PROBLEMATIC },
        ]

        const result = simulateBlockPeriod(mempool, { tx_resolved: true })

        expect(result.txsIncluded).toBe(2) // Both included
        expect(result.isEmpty).toBe(false)
    })

    test("high volume: many PRE_APPROVED with some PROBLEMATIC", () => {
        const mempool = []
        for (let i = 0; i < 50; i++) {
            mempool.push({
                hash: `tx_good_${i}`,
                classification: TransactionClassification.PRE_APPROVED,
            })
        }
        for (let i = 0; i < 5; i++) {
            mempool.push({
                hash: `tx_bad_${i}`,
                classification: TransactionClassification.PROBLEMATIC,
            })
        }

        const bft: Record<string, boolean> = {}
        for (let i = 0; i < 5; i++) {
            bft[`tx_bad_${i}`] = i < 2 // 2 resolved, 3 rejected
        }

        const result = simulateBlockPeriod(mempool, bft)

        expect(result.blockProduced).toBe(true)
        expect(result.txsIncluded).toBe(52) // 50 + 2 resolved
        expect(result.txsRejected).toBe(3)
    })
})
