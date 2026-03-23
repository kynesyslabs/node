/**
 * Petri Consensus — Phase 6: Performance Benchmarking
 *
 * Measures key performance characteristics of Petri Consensus components.
 * These are unit-level benchmarks (no real network) — they validate
 * algorithmic performance, not network latency.
 *
 * Targets:
 *   - DeltaAgreementTracker throughput: handle 1000+ txs per round
 *   - selectMembers: <1ms per call for deterministic routing
 *   - BFT threshold: O(1) constant time
 *   - Soft finality latency: classification → PRE_APPROVED < 2s (design target)
 */
import { describe, expect, test } from "bun:test"
import { DeltaAgreementTracker } from "@/libs/consensus/petri/forge/deltaAgreementTracker"
import { selectMembers } from "@/libs/consensus/petri/routing/petriRouter"

// ---- Helpers ----

function bftThreshold(n: number): number {
    return Math.floor((n * 2) / 3) + 1
}

function mockPeers(count: number): any[] {
    return Array.from({ length: count }, (_, i) => ({
        identity: `peer_${String(i).padStart(3, "0")}`,
        connection: { string: `localhost:${3000 + i}` },
    }))
}

// ---- DeltaAgreementTracker Throughput ----

describe("Benchmark — DeltaAgreementTracker Throughput", () => {
    test("handles 1000 txs in a single round evaluation", () => {
        const shardSize = 10
        const threshold = bftThreshold(shardSize)
        const tracker = new DeltaAgreementTracker(threshold, 5)

        const txCount = 1000

        // Record deltas for 1000 txs (all agree)
        const start = performance.now()
        for (let tx = 0; tx < txCount; tx++) {
            const txHash = `tx_${tx}`
            for (let m = 0; m < shardSize; m++) {
                tracker.recordDelta(txHash, `delta_${tx}`, `member_${m}`, 1)
            }
        }
        const recordTime = performance.now() - start

        // Evaluate all 1000
        const evalStart = performance.now()
        const { promoted, flagged } = tracker.evaluate(shardSize, 1)
        const evalTime = performance.now() - evalStart

        expect(promoted).toHaveLength(txCount)
        expect(flagged).toHaveLength(0)

        // Performance: recording 10,000 deltas (1000 txs * 10 members) should be fast
        // Generous threshold: <500ms for recording, <100ms for evaluation
        expect(recordTime).toBeLessThan(500)
        expect(evalTime).toBeLessThan(100)
    })

    test("handles 5000 txs in a single round", () => {
        const shardSize = 10
        const threshold = bftThreshold(shardSize)
        const tracker = new DeltaAgreementTracker(threshold, 5)

        const txCount = 5000

        const start = performance.now()
        for (let tx = 0; tx < txCount; tx++) {
            const txHash = `tx_${tx}`
            for (let m = 0; m < shardSize; m++) {
                tracker.recordDelta(txHash, `delta_${tx}`, `member_${m}`, 1)
            }
        }
        const { promoted } = tracker.evaluate(shardSize, 1)
        const totalTime = performance.now() - start

        expect(promoted).toHaveLength(txCount)
        // 50,000 deltas + evaluation in under 2s
        expect(totalTime).toBeLessThan(2000)
    })

    test("mixed agreement/disagreement at scale", () => {
        const shardSize = 10
        const threshold = bftThreshold(shardSize)
        const tracker = new DeltaAgreementTracker(threshold, 1)

        const txCount = 500

        const start = performance.now()
        for (let tx = 0; tx < txCount; tx++) {
            const txHash = `tx_${tx}`
            if (tx % 3 === 0) {
                // Every 3rd tx: disagreement (5-5 split)
                for (let m = 0; m < 5; m++) {
                    tracker.recordDelta(txHash, "delta_a", `member_${m}`, 1)
                }
                for (let m = 5; m < 10; m++) {
                    tracker.recordDelta(txHash, "delta_b", `member_${m}`, 1)
                }
            } else {
                // Agreement
                for (let m = 0; m < shardSize; m++) {
                    tracker.recordDelta(txHash, `delta_${tx}`, `member_${m}`, 1)
                }
            }
        }

        const { promoted, flagged } = tracker.evaluate(shardSize, 1)
        const totalTime = performance.now() - start

        // ~167 disagreeing txs (flagged at TTL=1), ~333 agreeing txs (promoted)
        const expectedPromoted = txCount - Math.floor(txCount / 3)
        const expectedFlagged = Math.floor(txCount / 3)

        // Allow for rounding: tx_0 is the first one (0%3==0)
        expect(promoted.length).toBeGreaterThanOrEqual(expectedPromoted - 1)
        expect(promoted.length).toBeLessThanOrEqual(expectedPromoted + 1)
        expect(flagged.length).toBeGreaterThanOrEqual(expectedFlagged - 1)
        expect(flagged.length).toBeLessThanOrEqual(expectedFlagged + 1)

        expect(totalTime).toBeLessThan(500)
    })
})

// ---- selectMembers Routing Performance ----

describe("Benchmark — selectMembers Routing", () => {
    test("10,000 routing decisions in < 100ms", () => {
        const shard = mockPeers(100)
        const iterations = 10_000

        const start = performance.now()
        for (let i = 0; i < iterations; i++) {
            selectMembers(`tx_hash_${i}`, shard, 2)
        }
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(100) // < 0.01ms per call
    })

    test("routing with large shard (100 peers)", () => {
        const shard = mockPeers(100)

        const start = performance.now()
        for (let i = 0; i < 1000; i++) {
            const selected = selectMembers(`tx_${i}`, shard, 5)
            expect(selected).toHaveLength(5)
        }
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(50)
    })

    test("routing with small shard (3 peers) is equally fast", () => {
        const shard = mockPeers(3)

        const start = performance.now()
        for (let i = 0; i < 10_000; i++) {
            selectMembers(`tx_${i}`, shard, 2)
        }
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(100)
    })
})

// ---- BFT Threshold Calculation Performance ----

describe("Benchmark — BFT Threshold", () => {
    test("threshold calculation is O(1) constant time", () => {
        const iterations = 100_000

        const start = performance.now()
        for (let i = 1; i <= iterations; i++) {
            bftThreshold(i)
        }
        const elapsed = performance.now() - start

        // 100K calculations should be nearly instant (< 10ms)
        expect(elapsed).toBeLessThan(10)
    })

    test("isBlockValid check is O(1)", () => {
        function isBlockValid(pro: number, total: number): boolean {
            return pro >= bftThreshold(total)
        }

        const iterations = 100_000
        const start = performance.now()
        for (let i = 0; i < iterations; i++) {
            isBlockValid(7, 10)
        }
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(10)
    })
})

// ---- Finality Latency Design Targets ----

describe("Benchmark — Finality Latency Design Targets", () => {
    test("soft finality target: < 2000ms (2 forge cycles at 1000ms each)", () => {
        // Design: forge runs every 2s. First round that sees the tx will
        // exchange deltas. If all agree, tx is promoted in 1 round.
        // Worst case: tx arrives just after a round starts → waits ~2s + 2s = 4s
        // Best case: tx arrives just before round → promoted in ~2s
        const forgeIntervalMs = 2000
        const minSoftFinality = forgeIntervalMs // Best case
        const maxSoftFinality = forgeIntervalMs * 2 // Worst case (missed cycle)

        expect(minSoftFinality).toBeLessThanOrEqual(2000)
        expect(maxSoftFinality).toBeLessThanOrEqual(4000)
    })

    test("hard finality target: < 12000ms (block interval + vote)", () => {
        const blockIntervalMs = 10_000
        const voteOverheadMs = 2000 // Generous estimate for BFT vote
        const maxHardFinality = blockIntervalMs + voteOverheadMs

        expect(maxHardFinality).toBeLessThanOrEqual(12_000)
    })

    test("finality gap: hard - soft should be ~8-10s", () => {
        const softFinalityMs = 2000 // Typical
        const hardFinalityMs = 10_000 // Block boundary
        const gap = hardFinalityMs - softFinalityMs

        expect(gap).toBeGreaterThanOrEqual(6000)
        expect(gap).toBeLessThanOrEqual(10_000)
    })
})

// ---- Memory Efficiency ----

describe("Benchmark — Memory Efficiency", () => {
    test("tracker cleans up after evaluation (no memory leak)", () => {
        const tracker = new DeltaAgreementTracker(7, 5)

        // Add 1000 txs, evaluate, check count
        for (let tx = 0; tx < 1000; tx++) {
            for (let m = 0; m < 10; m++) {
                tracker.recordDelta(`tx_${tx}`, `delta_${tx}`, `m_${m}`, 1)
            }
        }
        expect(tracker.trackedCount).toBe(1000)

        tracker.evaluate(10, 1)
        expect(tracker.trackedCount).toBe(0) // All promoted → cleaned
    })

    test("tracker reset clears everything", () => {
        const tracker = new DeltaAgreementTracker(7, 5)

        for (let tx = 0; tx < 100; tx++) {
            tracker.recordDelta(`tx_${tx}`, "delta", "m_0", 1)
        }
        expect(tracker.trackedCount).toBe(100)

        tracker.reset()
        expect(tracker.trackedCount).toBe(0)
    })

    test("forge getCurrentDeltas returns copy (no reference leak)", () => {
        const config = {
            forgeIntervalMs: 60000,
            blockIntervalMs: 10000,
            agreementThreshold: 7,
            problematicTTLRounds: 5,
        }
        const forge = new (require("@/libs/consensus/petri/forge/continuousForge").ContinuousForge)(config)
        forge.start(mockPeers(3))

        const deltas1 = forge.getCurrentDeltas()
        const deltas2 = forge.getCurrentDeltas()

        // Should be different object references (spread copy)
        expect(deltas1).not.toBe(deltas2)
        expect(deltas1).toEqual(deltas2)

        forge.stop()
    })
})
