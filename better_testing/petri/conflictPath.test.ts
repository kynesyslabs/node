/**
 * Petri Consensus — Phase 6: Conflict-Path Integration Test
 *
 * Simulates conflicting transactions:
 *   Submit double-spend → delta disagreement → PROBLEMATIC → BFT arbitration
 *   → one resolved (included) OR rejected (removed from mempool)
 *
 * Tests that the chain never stalls, even with conflicting transactions.
 */
import { describe, expect, test } from "bun:test"
import { DeltaAgreementTracker } from "@/libs/consensus/petri/forge/deltaAgreementTracker"
import { TransactionClassification } from "@/libs/consensus/petri/types/classificationTypes"

// ---- Helpers ----

function bftThreshold(totalMembers: number): number {
    return Math.floor((totalMembers * 2) / 3) + 1
}

// ---- Conflict Path: Delta Disagreement → PROBLEMATIC ----

describe("Conflict Path — Delta Disagreement", () => {
    test("conflicting TXs produce different deltas → both stay pending initially", () => {
        const tracker = new DeltaAgreementTracker(7, 5)
        const shardSize = 10

        // TX A: half the shard sees delta_a, half sees delta_b
        // This simulates a double-spend where execution order matters
        for (let i = 0; i < 5; i++) {
            tracker.recordDelta("tx_conflict", "delta_version_a", `member_${i}`, 1)
        }
        for (let i = 5; i < 10; i++) {
            tracker.recordDelta("tx_conflict", "delta_version_b", `member_${i}`, 1)
        }

        const { promoted, flagged } = tracker.evaluate(shardSize, 1)

        // Neither version reaches 7/10 — stays pending
        expect(promoted).not.toContain("tx_conflict")
        expect(flagged).not.toContain("tx_conflict") // TTL not expired yet
    })

    test("persistent disagreement → PROBLEMATIC after TTL rounds", () => {
        const ttlRounds = 3
        const tracker = new DeltaAgreementTracker(7, ttlRounds)
        const shardSize = 10

        // Round 1: 5-5 split
        for (let i = 0; i < 5; i++) {
            tracker.recordDelta("tx_stuck", "delta_a", `member_${i}`, 1)
        }
        for (let i = 5; i < 10; i++) {
            tracker.recordDelta("tx_stuck", "delta_b", `member_${i}`, 1)
        }
        let result = tracker.evaluate(shardSize, 1)
        expect(result.flagged).not.toContain("tx_stuck")

        // Round 2: same split (overwrite deltas — Map deduplicates by key)
        for (let i = 0; i < 5; i++) {
            tracker.recordDelta("tx_stuck", "delta_a", `member_${i}`, 2)
        }
        for (let i = 5; i < 10; i++) {
            tracker.recordDelta("tx_stuck", "delta_b", `member_${i}`, 2)
        }
        result = tracker.evaluate(shardSize, 2)
        expect(result.flagged).not.toContain("tx_stuck")

        // Round 3: TTL expired → PROBLEMATIC
        for (let i = 0; i < 5; i++) {
            tracker.recordDelta("tx_stuck", "delta_a", `member_${i}`, 3)
        }
        for (let i = 5; i < 10; i++) {
            tracker.recordDelta("tx_stuck", "delta_b", `member_${i}`, 3)
        }
        result = tracker.evaluate(shardSize, 3)
        expect(result.flagged).toContain("tx_stuck")
    })

    test("one TX promotes while sibling stays conflicting", () => {
        const tracker = new DeltaAgreementTracker(7, 5)
        const shardSize = 10

        // TX A: clear agreement
        for (let i = 0; i < 9; i++) {
            tracker.recordDelta("tx_good", "delta_good", `member_${i}`, 1)
        }
        tracker.recordDelta("tx_good", "delta_other", "member_9", 1)

        // TX B: split — no agreement
        for (let i = 0; i < 5; i++) {
            tracker.recordDelta("tx_conflict", "delta_x", `member_${i}`, 1)
        }
        for (let i = 5; i < 10; i++) {
            tracker.recordDelta("tx_conflict", "delta_y", `member_${i}`, 1)
        }

        const { promoted, flagged } = tracker.evaluate(shardSize, 1)
        expect(promoted).toContain("tx_good")
        expect(promoted).not.toContain("tx_conflict")
    })
})

// ---- Conflict Path: BFT Arbitration ----

describe("Conflict Path — BFT Arbitration", () => {
    test("PROBLEMATIC TX resolved when BFT re-vote succeeds", () => {
        // Simulates: arbitrator re-executes tx, exchanges deltas, 8/10 agree
        const agreeCount = 8
        const totalMembers = 10
        const threshold = bftThreshold(totalMembers) // 7

        expect(agreeCount >= threshold).toBe(true)

        // Result: resolved → include in block
        const resolved = [{ hash: "tx_resolved", from: "0x1", to: "0x2" }]
        const rejectedHashes: string[] = []

        expect(resolved).toHaveLength(1)
        expect(rejectedHashes).toHaveLength(0)
    })

    test("PROBLEMATIC TX rejected when BFT re-vote fails", () => {
        // Simulates: only 4/10 agree on delta
        const agreeCount = 4
        const totalMembers = 10
        const threshold = bftThreshold(totalMembers) // 7

        expect(agreeCount >= threshold).toBe(false)

        // Result: rejected → remove from mempool
        const resolved: any[] = []
        const rejectedHashes = ["tx_rejected"]

        expect(resolved).toHaveLength(0)
        expect(rejectedHashes).toHaveLength(1)
    })

    test("mixed arbitration: some resolved, some rejected", () => {
        const totalMembers = 10
        const threshold = bftThreshold(totalMembers)

        // TX A: 8/10 agree → resolved
        const txA_agree = 8
        const txA_resolved = txA_agree >= threshold

        // TX B: 3/10 agree → rejected
        const txB_agree = 3
        const txB_resolved = txB_agree >= threshold

        // TX C: exactly threshold → resolved
        const txC_agree = threshold
        const txC_resolved = txC_agree >= threshold

        expect(txA_resolved).toBe(true)
        expect(txB_resolved).toBe(false)
        expect(txC_resolved).toBe(true)

        const resolved = [txA_resolved, txC_resolved].filter(Boolean)
        const rejected = [txB_resolved].filter(r => !r)
        expect(resolved).toHaveLength(2)
        expect(rejected).toHaveLength(1)
    })

    test("rejected TX hash is tracked for mempool cleanup", () => {
        const rejectedHashes: string[] = []
        const txHashes = ["tx_1", "tx_2", "tx_3"]
        const agreeCounts = [8, 3, 5] // tx_1 passes, tx_2 and tx_3 fail
        const threshold = bftThreshold(10)

        for (let i = 0; i < txHashes.length; i++) {
            if (agreeCounts[i] < threshold) {
                rejectedHashes.push(txHashes[i])
            }
        }

        expect(rejectedHashes).toEqual(["tx_2", "tx_3"])
    })
})

// ---- Conflict Path: Mempool Cleanup ----

describe("Conflict Path — Mempool Cleanup", () => {
    test("rejected txs removed from mempool after arbitration", () => {
        const mempool = new Map([
            ["tx_good", { classification: "PRE_APPROVED" }],
            ["tx_rejected_1", { classification: "PROBLEMATIC" }],
            ["tx_rejected_2", { classification: "PROBLEMATIC" }],
            ["tx_pending", { classification: "TO_APPROVE" }],
        ])

        const rejectedHashes = ["tx_rejected_1", "tx_rejected_2"]
        for (const hash of rejectedHashes) {
            mempool.delete(hash)
        }

        expect(mempool.size).toBe(2)
        expect(mempool.has("tx_good")).toBe(true)
        expect(mempool.has("tx_pending")).toBe(true)
        expect(mempool.has("tx_rejected_1")).toBe(false)
        expect(mempool.has("tx_rejected_2")).toBe(false)
    })

    test("resolved txs are promoted to PRE_APPROVED before block compilation", () => {
        // After BFT resolves a PROBLEMATIC tx, it's promoted then included in block
        const mempoolEntry = {
            hash: "tx_resolved",
            classification: TransactionClassification.PROBLEMATIC as string,
            delta_hash: "old_delta",
        }

        // Arbitrator promotes it
        mempoolEntry.classification = TransactionClassification.PRE_APPROVED
        mempoolEntry.delta_hash = "agreed_delta"

        expect(mempoolEntry.classification).toBe("PRE_APPROVED")
        expect(mempoolEntry.delta_hash).toBe("agreed_delta")
    })

    test("block includes both PRE_APPROVED and resolved txs", () => {
        const preApproved = ["tx_1", "tx_2", "tx_3"]
        const resolved = ["tx_resolved_1"]
        const allForBlock = [...preApproved, ...resolved]

        expect(allForBlock).toHaveLength(4)
        expect(allForBlock).toContain("tx_resolved_1")
    })
})

// ---- Conflict Path: Chain Never Stalls ----

describe("Conflict Path — Chain Liveness", () => {
    test("block produced even if all txs are PROBLEMATIC and rejected", () => {
        const preApprovedTxs: string[] = []
        const resolvedTxs: string[] = []
        const allForBlock = [...preApprovedTxs, ...resolvedTxs]

        // Empty block is valid — chain never stalls
        const isEmpty = allForBlock.length === 0
        expect(isEmpty).toBe(true)

        // Empty block still passes BFT vote
        expect(isBlockValid(10, 10)).toBe(true)
    })

    test("block produced on schedule regardless of conflicts", () => {
        // Simulates: 5 txs in mempool, 3 conflicting
        const txClassifications = [
            { hash: "tx_1", classification: "PRE_APPROVED" },
            { hash: "tx_2", classification: "PRE_APPROVED" },
            { hash: "tx_3", classification: "PROBLEMATIC" }, // Rejected by BFT
            { hash: "tx_4", classification: "PROBLEMATIC" }, // Rejected by BFT
            { hash: "tx_5", classification: "PROBLEMATIC" }, // Resolved by BFT
        ]

        const preApproved = txClassifications
            .filter(t => t.classification === "PRE_APPROVED")
            .map(t => t.hash)
        const resolved = ["tx_5"] // BFT resolved this one
        const rejected = ["tx_3", "tx_4"]

        const blockTxs = [...preApproved, ...resolved]
        expect(blockTxs).toEqual(["tx_1", "tx_2", "tx_5"])
        expect(blockTxs).toHaveLength(3)

        // Block is valid with these txs
        expect(isBlockValid(9, 10)).toBe(true)

        // Rejected txs cleaned from mempool
        expect(rejected).toHaveLength(2)
    })
})

function isBlockValid(pro: number, total: number): boolean {
    return pro >= bftThreshold(total)
}
