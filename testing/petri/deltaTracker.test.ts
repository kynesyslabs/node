/**
 * Petri Consensus — DeltaAgreementTracker unit tests
 *
 * Tests the core agreement/flagging logic:
 * - Promotion when threshold is met
 * - Flagging when TTL expires without agreement
 * - Mixed scenarios with multiple transactions
 * - Edge cases: single member, all agree, all disagree
 */
import { describe, expect, test, beforeEach } from "bun:test"
import { DeltaAgreementTracker } from "@/libs/consensus/petri/forge/deltaAgreementTracker"

describe("DeltaAgreementTracker", () => {
    let tracker: DeltaAgreementTracker

    // Default: 7/10 threshold, 5-round TTL
    beforeEach(() => {
        tracker = new DeltaAgreementTracker(7, 5)
    })

    test("promotes tx when threshold is met", () => {
        const txHash = "tx1"
        const deltaHash = "delta_abc"

        // 7 members agree on the same hash
        for (let i = 0; i < 7; i++) {
            tracker.recordDelta(txHash, deltaHash, `member_${i}`, 1)
        }

        const result = tracker.evaluate(10, 1)
        expect(result.promoted).toContain(txHash)
        expect(result.flagged).not.toContain(txHash)
    })

    test("does not promote when below threshold", () => {
        const txHash = "tx1"
        const deltaHash = "delta_abc"

        // Only 6 members agree — below 7 threshold
        for (let i = 0; i < 6; i++) {
            tracker.recordDelta(txHash, deltaHash, `member_${i}`, 1)
        }

        const result = tracker.evaluate(10, 1)
        expect(result.promoted).not.toContain(txHash)
        expect(result.flagged).not.toContain(txHash) // Not yet TTL
    })

    test("flags tx when TTL expires without agreement", () => {
        const txHash = "tx1"

        // Each member has a different hash — no agreement possible
        for (let i = 0; i < 10; i++) {
            tracker.recordDelta(txHash, `different_hash_${i}`, `member_${i}`, 1)
        }

        // First 4 rounds: not yet flagged
        for (let round = 1; round <= 4; round++) {
            const result = tracker.evaluate(10, round)
            expect(result.flagged).not.toContain(txHash)
        }

        // Round 5: TTL expired, should be flagged
        const result = tracker.evaluate(10, 5)
        expect(result.flagged).toContain(txHash)
    })

    test("handles mixed: some promoted, some flagged", () => {
        // tx1: 7 agree → promoted
        for (let i = 0; i < 7; i++) {
            tracker.recordDelta("tx1", "same_hash", `member_${i}`, 1)
        }

        // tx2: all disagree, first seen round 1
        for (let i = 0; i < 10; i++) {
            tracker.recordDelta("tx2", `diff_${i}`, `member_${i}`, 1)
        }

        // Evaluate at round 5 (TTL for tx2)
        const result = tracker.evaluate(10, 5)
        expect(result.promoted).toContain("tx1")
        expect(result.flagged).toContain("tx2")
    })

    test("cleans up promoted and flagged txs from tracking", () => {
        for (let i = 0; i < 7; i++) {
            tracker.recordDelta("tx1", "hash_a", `member_${i}`, 1)
        }

        expect(tracker.trackedCount).toBe(1)

        tracker.evaluate(10, 1)

        // After evaluation, promoted tx is removed
        expect(tracker.trackedCount).toBe(0)
    })

    test("handles late-arriving deltas (mid-round)", () => {
        const txHash = "tx1"

        // Round 1: 3 members report
        for (let i = 0; i < 3; i++) {
            tracker.recordDelta(txHash, "hash_a", `member_${i}`, 1)
        }
        let result = tracker.evaluate(10, 1)
        expect(result.promoted).not.toContain(txHash)

        // Round 2: 4 more members report same hash (total 7)
        for (let i = 3; i < 7; i++) {
            tracker.recordDelta(txHash, "hash_a", `member_${i}`, 2)
        }
        result = tracker.evaluate(10, 2)
        expect(result.promoted).toContain(txHash)
    })

    test("majority wins even with some disagreement", () => {
        const txHash = "tx1"

        // 7 agree on hash_a
        for (let i = 0; i < 7; i++) {
            tracker.recordDelta(txHash, "hash_a", `member_${i}`, 1)
        }
        // 3 have different hash
        for (let i = 7; i < 10; i++) {
            tracker.recordDelta(txHash, "hash_b", `member_${i}`, 1)
        }

        const result = tracker.evaluate(10, 1)
        expect(result.promoted).toContain(txHash)
    })

    test("reset clears all state", () => {
        for (let i = 0; i < 5; i++) {
            tracker.recordDelta("tx1", "hash", `m_${i}`, 1)
        }
        expect(tracker.trackedCount).toBe(1)

        tracker.reset()
        expect(tracker.trackedCount).toBe(0)
    })

    test("getComparison returns correct breakdown", () => {
        tracker.recordDelta("tx1", "hash_a", "m_0", 1)
        tracker.recordDelta("tx1", "hash_a", "m_1", 1)
        tracker.recordDelta("tx1", "hash_b", "m_2", 1)

        const comparison = tracker.getComparison("tx1", "hash_a", 5)
        expect(comparison).not.toBeNull()
        if (!comparison) return // type guard for TS
        expect(comparison.agreeCount).toBe(2)
        expect(comparison.disagreeCount).toBe(1)
        expect(comparison.missingCount).toBe(2)
        expect(comparison.totalMembers).toBe(5)
        expect(comparison.agreed).toBe(false) // 2 < 7 threshold
    })

    test("getComparison returns null for unknown tx", () => {
        expect(tracker.getComparison("unknown", "hash", 10)).toBeNull()
    })

    test("exact threshold boundary: 7 of 10 promotes", () => {
        for (let i = 0; i < 7; i++) {
            tracker.recordDelta("tx1", "hash_x", `m_${i}`, 1)
        }
        const result = tracker.evaluate(10, 1)
        expect(result.promoted).toContain("tx1")
    })

    test("exact threshold boundary: 6 of 10 does not promote", () => {
        for (let i = 0; i < 6; i++) {
            tracker.recordDelta("tx1", "hash_x", `m_${i}`, 1)
        }
        // One different
        tracker.recordDelta("tx1", "hash_y", "m_6", 1)

        const result = tracker.evaluate(10, 1)
        expect(result.promoted).not.toContain("tx1")
    })

    test("custom threshold: 3 of 5", () => {
        const smallTracker = new DeltaAgreementTracker(3, 5)

        for (let i = 0; i < 3; i++) {
            smallTracker.recordDelta("tx1", "hash_a", `m_${i}`, 1)
        }

        const result = smallTracker.evaluate(5, 1)
        expect(result.promoted).toContain("tx1")
    })

    test("custom TTL: flags after 2 rounds", () => {
        const fastTracker = new DeltaAgreementTracker(7, 2)

        for (let i = 0; i < 5; i++) {
            fastTracker.recordDelta("tx1", `diff_${i}`, `m_${i}`, 1)
        }

        const r1 = fastTracker.evaluate(10, 1)
        expect(r1.flagged).not.toContain("tx1")

        const r2 = fastTracker.evaluate(10, 2)
        expect(r2.flagged).toContain("tx1")
    })

    test("multiple txs tracked independently", () => {
        // tx1: promoted immediately
        for (let i = 0; i < 7; i++) {
            tracker.recordDelta("tx1", "hash_same", `m_${i}`, 1)
        }

        // tx2: still pending (only 3 agree)
        for (let i = 0; i < 3; i++) {
            tracker.recordDelta("tx2", "hash_x", `m_${i}`, 1)
        }

        const result = tracker.evaluate(10, 1)
        expect(result.promoted).toContain("tx1")
        expect(result.promoted).not.toContain("tx2")
        expect(result.flagged).not.toContain("tx2")

        // tx1 cleaned, tx2 still tracked
        expect(tracker.trackedCount).toBe(1)
    })
})
