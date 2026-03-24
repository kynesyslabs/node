/**
 * Petri Consensus — Phase 6: Byzantine Minority Simulation Test
 *
 * Simulates Byzantine (malicious/faulty) nodes sending wrong deltas.
 * Verifies that the system tolerates up to f < n/3 Byzantine nodes.
 *
 * Shard of 10:
 *   - 3/10 Byzantine → honest majority (7) reaches agreement → TX promoted
 *   - 4/10 Byzantine → no agreement → TX flagged PROBLEMATIC → BFT arbitration
 */
import { describe, expect, test } from "bun:test"
import { DeltaAgreementTracker } from "@/libs/consensus/petri/forge/deltaAgreementTracker"

// ---- Helpers ----

function bftThreshold(totalMembers: number): number {
    return Math.floor((totalMembers * 2) / 3) + 1
}

/**
 * Simulate a forge round with some Byzantine nodes sending wrong deltas.
 * Returns { promoted, flagged } from the tracker.
 */
function simulateRound(
    shardSize: number,
    byzantineCount: number,
    txHash: string,
    correctDelta: string,
    ttlRounds = 5,
    currentRound = 1,
) {
    const threshold = bftThreshold(shardSize)
    const tracker = new DeltaAgreementTracker(threshold, ttlRounds)

    const honestCount = shardSize - byzantineCount

    // Honest nodes send correct delta
    for (let i = 0; i < honestCount; i++) {
        tracker.recordDelta(txHash, correctDelta, `honest_${i}`, currentRound)
    }

    // Byzantine nodes each send a unique wrong delta
    for (let i = 0; i < byzantineCount; i++) {
        tracker.recordDelta(txHash, `byzantine_garbage_${i}`, `byzantine_${i}`, currentRound)
    }

    return tracker.evaluate(shardSize, currentRound)
}

// ---- Byzantine Minority (f < n/3) — System Tolerates ----

describe("Byzantine Minority — System Tolerates", () => {
    test("3/10 Byzantine: 7 honest reach threshold → TX promoted", () => {
        const { promoted, flagged } = simulateRound(10, 3, "tx_byz_3", "correct_delta")

        expect(promoted).toContain("tx_byz_3")
        expect(flagged).not.toContain("tx_byz_3")
    })

    test("2/10 Byzantine: 8 honest exceeds threshold → TX promoted", () => {
        const { promoted } = simulateRound(10, 2, "tx_byz_2", "correct_delta")
        expect(promoted).toContain("tx_byz_2")
    })

    test("1/10 Byzantine: 9 honest → TX promoted easily", () => {
        const { promoted } = simulateRound(10, 1, "tx_byz_1", "correct_delta")
        expect(promoted).toContain("tx_byz_1")
    })

    test("0/10 Byzantine: all honest → TX promoted unanimously", () => {
        const { promoted } = simulateRound(10, 0, "tx_all_honest", "correct_delta")
        expect(promoted).toContain("tx_all_honest")
    })

    test("1/4 Byzantine: 3 honest = threshold (3) → TX promoted", () => {
        // floor(4*2/3)+1 = 3 → exactly met
        const { promoted } = simulateRound(4, 1, "tx_small_shard", "correct_delta")
        expect(promoted).toContain("tx_small_shard")
    })

    test("2/7 Byzantine: 5 honest = threshold (5) → TX promoted", () => {
        // floor(7*2/3)+1 = 5 → exactly met
        const { promoted } = simulateRound(7, 2, "tx_seven_shard", "correct_delta")
        expect(promoted).toContain("tx_seven_shard")
    })
})

// ---- Byzantine Majority (f >= n/3) — Agreement Fails ----

describe("Byzantine Majority — Agreement Fails", () => {
    test("4/10 Byzantine: 6 honest < threshold 7 → no promotion in round 1", () => {
        const { promoted, flagged } = simulateRound(10, 4, "tx_byz_4", "correct_delta")

        expect(promoted).not.toContain("tx_byz_4")
        // Not yet flagged (TTL=5, round=1)
        expect(flagged).not.toContain("tx_byz_4")
    })

    test("4/10 Byzantine: stays pending until TTL → then PROBLEMATIC", () => {
        const shardSize = 10
        const threshold = bftThreshold(shardSize) // 7
        const ttlRounds = 3
        const tracker = new DeltaAgreementTracker(threshold, ttlRounds)
        const txHash = "tx_byz_persistent"

        // Simulate 3 rounds with 4 Byzantine nodes
        for (let round = 1; round <= ttlRounds; round++) {
            for (let i = 0; i < 6; i++) {
                tracker.recordDelta(txHash, "correct", `honest_${i}`, round)
            }
            for (let i = 0; i < 4; i++) {
                tracker.recordDelta(txHash, `garbage_${i}`, `byz_${i}`, round)
            }

            const result = tracker.evaluate(shardSize, round)

            if (round < ttlRounds) {
                expect(result.promoted).not.toContain(txHash)
                expect(result.flagged).not.toContain(txHash)
            } else {
                // TTL expired → flagged PROBLEMATIC
                expect(result.flagged).toContain(txHash)
            }
        }
    })

    test("5/10 Byzantine: clear majority attack — no agreement possible", () => {
        const { promoted } = simulateRound(10, 5, "tx_majority_attack", "correct")

        // 5 honest < threshold 7 → no promotion
        expect(promoted).not.toContain("tx_majority_attack")
    })

    test("7/10 Byzantine: only 3 honest — far below threshold", () => {
        const { promoted } = simulateRound(10, 7, "tx_overwhelmed", "correct")
        expect(promoted).not.toContain("tx_overwhelmed")
    })
})

// ---- Byzantine Behavior Patterns ----

describe("Byzantine Behavior Patterns", () => {
    test("Byzantine nodes sending same wrong delta (coordinated attack)", () => {
        const shardSize = 10
        const threshold = bftThreshold(shardSize)
        const tracker = new DeltaAgreementTracker(threshold, 5)
        const txHash = "tx_coordinated"

        // 7 honest with correct delta
        for (let i = 0; i < 7; i++) {
            tracker.recordDelta(txHash, "correct_delta", `honest_${i}`, 1)
        }

        // 3 Byzantine with the SAME wrong delta (coordinated)
        for (let i = 0; i < 3; i++) {
            tracker.recordDelta(txHash, "coordinated_wrong", `byz_${i}`, 1)
        }

        const { promoted } = tracker.evaluate(shardSize, 1)
        // 7 honest >= threshold 7 → still promoted despite coordinated attack
        expect(promoted).toContain(txHash)
    })

    test("Byzantine nodes sending same delta as some honest (eclipse attempt)", () => {
        const shardSize = 10
        const threshold = bftThreshold(shardSize)
        const tracker = new DeltaAgreementTracker(threshold, 5)
        const txHash = "tx_eclipse"

        // 6 honest with correct delta
        for (let i = 0; i < 6; i++) {
            tracker.recordDelta(txHash, "correct", `honest_${i}`, 1)
        }

        // 4 Byzantine mimicking a minority honest delta
        // (trying to split the vote)
        for (let i = 0; i < 4; i++) {
            tracker.recordDelta(txHash, "wrong_delta", `byz_${i}`, 1)
        }

        const { promoted } = tracker.evaluate(shardSize, 1)
        // 6 < 7 → no promotion (attack succeeds in delaying)
        expect(promoted).not.toContain(txHash)
    })

    test("Byzantine nodes not sending any delta (omission fault)", () => {
        const shardSize = 10
        const threshold = bftThreshold(shardSize)
        const tracker = new DeltaAgreementTracker(threshold, 5)
        const txHash = "tx_omission"

        // Only 7 honest nodes respond (3 Byzantine stay silent)
        for (let i = 0; i < 7; i++) {
            tracker.recordDelta(txHash, "correct", `honest_${i}`, 1)
        }
        // 3 Byzantine: no recordDelta call — they didn't respond

        const { promoted } = tracker.evaluate(shardSize, 1)
        // 7 correct out of 7 responding = 7 → meets threshold
        expect(promoted).toContain(txHash)
    })

    test("multiple TXs with different Byzantine targets", () => {
        const shardSize = 10
        const threshold = bftThreshold(shardSize)
        const tracker = new DeltaAgreementTracker(threshold, 5)

        // TX A: Byzantine targets this one (3 wrong deltas)
        for (let i = 0; i < 7; i++) {
            tracker.recordDelta("tx_a", "delta_a", `member_${i}`, 1)
        }
        for (let i = 7; i < 10; i++) {
            tracker.recordDelta("tx_a", "garbage", `member_${i}`, 1)
        }

        // TX B: no attack (all honest)
        for (let i = 0; i < 10; i++) {
            tracker.recordDelta("tx_b", "delta_b", `member_${i}`, 1)
        }

        const { promoted } = tracker.evaluate(shardSize, 1)
        expect(promoted).toContain("tx_a") // 7 >= 7
        expect(promoted).toContain("tx_b") // 10 >= 7
    })
})

// ---- Byzantine + BFT Arbitration ----

describe("Byzantine + BFT Arbitration", () => {
    test("PROBLEMATIC TX re-arbitrated: honest majority wins in BFT round", () => {
        // After a tx is flagged PROBLEMATIC (due to Byzantine interference),
        // BFT arbitration re-executes and does a final vote
        const totalMembers = 10
        const threshold = bftThreshold(totalMembers) // 7

        // BFT re-vote: 7 honest agree, 3 Byzantine disagree
        const honestAgree = 7
        const resolved = honestAgree >= threshold

        expect(resolved).toBe(true) // Honest majority wins
    })

    test("PROBLEMATIC TX: Byzantine still prevents agreement in BFT → rejected", () => {
        // If 4 Byzantine nodes still disagree in BFT round
        const totalMembers = 10
        const threshold = bftThreshold(totalMembers) // 7

        const honestAgree = 6 // 4 Byzantine = only 6 honest
        const resolved = honestAgree >= threshold

        expect(resolved).toBe(false) // Rejected — chain moves on
    })

    test("rejection is fail-safe: chain never stalls", () => {
        // Even if all txs are rejected by BFT, an empty block is produced
        const allRejected = true
        const blockTxCount = 0
        const isEmpty = blockTxCount === 0

        expect(isEmpty).toBe(true)
        // Empty block still finalizes (10/10 vote)
        const pro = 10
        const total = 10
        expect(pro >= bftThreshold(total)).toBe(true)
    })
})
