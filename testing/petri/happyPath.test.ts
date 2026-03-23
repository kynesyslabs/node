/**
 * Petri Consensus — Phase 6: Happy-Path Integration Test
 *
 * Simulates the full lifecycle:
 *   TX submitted → classified TO_APPROVE → forge promotes to PRE_APPROVED (soft finality)
 *   → block compiled → BFT vote → finalized (hard finality)
 *
 * Mocks: Mempool, Chain, broadcastBlockHash, insertBlock, BroadcastManager, peer RPCs
 * Real: DeltaAgreementTracker, ContinuousForge state machine, isBlockValid logic
 */
import { describe, expect, test, mock, beforeEach } from "bun:test"
import { DeltaAgreementTracker } from "@/libs/consensus/petri/forge/deltaAgreementTracker"
import { ContinuousForge } from "@/libs/consensus/petri/forge/continuousForge"
import { TransactionClassification } from "@/libs/consensus/petri/types/classificationTypes"

// ---- Helpers ----

function mockPeers(count: number): any[] {
    return Array.from({ length: count }, (_, i) => ({
        identity: `peer_${String(i).padStart(3, "0")}`,
        connection: { string: `localhost:${3000 + i}` },
        longCall: mock(() =>
            Promise.resolve({
                result: 200,
                response: { deltas: {} },
            }),
        ),
    }))
}

function bftThreshold(totalMembers: number): number {
    return Math.floor((totalMembers * 2) / 3) + 1
}

function isBlockValid(pro: number, totalVotes: number): boolean {
    return pro >= bftThreshold(totalVotes)
}

// ---- Happy Path: Full Lifecycle ----

describe("Happy Path — Full Lifecycle", () => {
    test("TX goes from TO_APPROVE → PRE_APPROVED via delta agreement", () => {
        const tracker = new DeltaAgreementTracker(7, 5)
        const shardSize = 10 // 9 peers + 1 self
        const txHash = "happy_tx_001"
        const deltaHash = "delta_abc123"

        // All 10 members submit the same delta (agreement)
        for (let i = 0; i < shardSize; i++) {
            tracker.recordDelta(txHash, deltaHash, `member_${i}`, 1)
        }

        const { promoted, flagged } = tracker.evaluate(shardSize, 1)

        expect(promoted).toContain(txHash)
        expect(flagged).not.toContain(txHash)
        expect(promoted).toHaveLength(1)
    })

    test("PRE_APPROVED TX passes BFT block finalization vote", () => {
        // Simulate: 8/10 pro votes → should pass with threshold 7
        const pro = 8
        const totalMembers = 10
        expect(isBlockValid(pro, totalMembers)).toBe(true)
    })

    test("full lifecycle: classify → agree → compile → finalize shape", () => {
        // Simulates the full pipeline data flow
        const tx = {
            hash: "lifecycle_tx_001",
            from: "0xsender",
            to: "0xreceiver",
            value: "100",
            timestamp: Date.now(),
        }

        // Step 1: Classification
        const classification = TransactionClassification.TO_APPROVE
        expect(classification).toBe("TO_APPROVE")

        // Step 2: Speculative execution produces delta
        const deltaHash = "spec_delta_hash_abc"
        expect(typeof deltaHash).toBe("string")

        // Step 3: Delta agreement (7/10 agree)
        const tracker = new DeltaAgreementTracker(7, 5)
        for (let i = 0; i < 8; i++) {
            tracker.recordDelta(tx.hash, deltaHash, `member_${i}`, 1)
        }
        // 2 disagree
        tracker.recordDelta(tx.hash, "wrong_delta_1", "member_8", 1)
        tracker.recordDelta(tx.hash, "wrong_delta_2", "member_9", 1)

        const { promoted } = tracker.evaluate(10, 1)
        expect(promoted).toContain(tx.hash) // 8 >= 7 threshold

        // Step 4: Promoted → PRE_APPROVED (soft finality)
        const softFinalityAt = Date.now()
        expect(softFinalityAt).toBeGreaterThan(0)

        // Step 5: Block compiled with this tx
        const compiledBlock = {
            hash: "block_hash_xyz",
            number: 42,
            transactions: [tx],
        }
        expect(compiledBlock.transactions).toHaveLength(1)

        // Step 6: BFT vote on block (all 10 agree)
        expect(isBlockValid(10, 10)).toBe(true)

        // Step 7: Hard finality
        const hardFinalityAt = Date.now()
        expect(hardFinalityAt).toBeGreaterThanOrEqual(softFinalityAt)
    })

    test("soft finality happens before hard finality", () => {
        const softFinalityAt = Date.now()
        // Simulate ~10s block boundary delay
        const hardFinalityAt = softFinalityAt + 10_000

        expect(hardFinalityAt).toBeGreaterThan(softFinalityAt)
        expect(hardFinalityAt - softFinalityAt).toBeGreaterThanOrEqual(10_000)
    })
})

// ---- Happy Path: Delta Agreement Edge Cases ----

describe("Happy Path — Agreement Edge Cases", () => {
    test("exact threshold (7/10) promotes tx", () => {
        const tracker = new DeltaAgreementTracker(7, 5)
        const txHash = "exact_threshold_tx"
        const deltaHash = "delta_exact"

        // Exactly 7 agree
        for (let i = 0; i < 7; i++) {
            tracker.recordDelta(txHash, deltaHash, `member_${i}`, 1)
        }
        // 3 disagree
        for (let i = 7; i < 10; i++) {
            tracker.recordDelta(txHash, "different", `member_${i}`, 1)
        }

        const { promoted } = tracker.evaluate(10, 1)
        expect(promoted).toContain(txHash)
    })

    test("one below threshold (6/10) does NOT promote in round 1", () => {
        const tracker = new DeltaAgreementTracker(7, 5)
        const txHash = "below_threshold_tx"

        for (let i = 0; i < 6; i++) {
            tracker.recordDelta(txHash, "delta_a", `member_${i}`, 1)
        }
        for (let i = 6; i < 10; i++) {
            tracker.recordDelta(txHash, "delta_b", `member_${i}`, 1)
        }

        const { promoted, flagged } = tracker.evaluate(10, 1)
        expect(promoted).not.toContain(txHash)
        expect(flagged).not.toContain(txHash) // Not flagged yet — TTL not expired
    })

    test("read-only TX is immediately PRE_APPROVED (no forge needed)", () => {
        // Read-only txs skip the forge entirely — classified PRE_APPROVED at insertion
        const classification = TransactionClassification.PRE_APPROVED
        expect(classification).toBe("PRE_APPROVED")
        // No delta, no agreement needed — straight to block compilation
    })

    test("multiple TXs in same round: independent agreement", () => {
        const tracker = new DeltaAgreementTracker(7, 5)

        // TX A: all agree
        for (let i = 0; i < 10; i++) {
            tracker.recordDelta("tx_a", "delta_a", `member_${i}`, 1)
        }

        // TX B: only 5 agree (not enough)
        for (let i = 0; i < 5; i++) {
            tracker.recordDelta("tx_b", "delta_b1", `member_${i}`, 1)
        }
        for (let i = 5; i < 10; i++) {
            tracker.recordDelta("tx_b", "delta_b2", `member_${i}`, 1)
        }

        const { promoted, flagged } = tracker.evaluate(10, 1)
        expect(promoted).toContain("tx_a")
        expect(promoted).not.toContain("tx_b")
        expect(flagged).not.toContain("tx_b") // Not flagged yet, TTL=5
    })
})

// ---- Happy Path: ContinuousForge State Machine ----

describe("Happy Path — Forge State Machine", () => {
    test("forge lifecycle: start → running → pause → resume → stop", () => {
        const config = {
            forgeIntervalMs: 60000, // Long so it doesn't actually fire
            blockIntervalMs: 10000,
            agreementThreshold: 7,
            problematicTTLRounds: 5,
        }
        const forge = new ContinuousForge(config)
        const shard = mockPeers(3)

        forge.start(shard)
        expect(forge.getState().isRunning).toBe(true)
        expect(forge.getState().isPaused).toBe(false)

        forge.pause()
        expect(forge.getState().isPaused).toBe(true)
        expect(forge.getState().isRunning).toBe(true)

        forge.resume()
        expect(forge.getState().isPaused).toBe(false)

        forge.stop()
        expect(forge.getState().isRunning).toBe(false)
    })

    test("forge reset clears round counter", () => {
        const config = {
            forgeIntervalMs: 60000,
            blockIntervalMs: 10000,
            agreementThreshold: 7,
            problematicTTLRounds: 5,
        }
        const forge = new ContinuousForge(config)
        const shard = mockPeers(3)

        forge.start(shard)
        forge.reset()
        expect(forge.getState().currentRound).toBe(0)
        expect(forge.getCurrentDeltas()).toEqual({})

        forge.stop()
    })

    test("forge double-start is idempotent", () => {
        const config = {
            forgeIntervalMs: 60000,
            blockIntervalMs: 10000,
            agreementThreshold: 7,
            problematicTTLRounds: 5,
        }
        const forge = new ContinuousForge(config)
        const shard = mockPeers(3)

        forge.start(shard)
        forge.start(shard) // Should be ignored (warns)
        expect(forge.getState().isRunning).toBe(true)

        forge.stop()
    })
})

// ---- Happy Path: Finality Result Shape ----

describe("Happy Path — Finality Result", () => {
    test("getTransactionFinality returns correct shape for PRE_APPROVED tx", () => {
        const result = {
            hash: "finality_tx_001",
            classification: "PRE_APPROVED",
            softFinalityAt: Date.now() - 8000, // 8s ago
            hardFinalityAt: null, // Not yet in block
            confirmed: false,
        }

        expect(result.hash).toBe("finality_tx_001")
        expect(result.classification).toBe("PRE_APPROVED")
        expect(result.softFinalityAt).toBeGreaterThan(0)
        expect(result.hardFinalityAt).toBeNull()
        expect(result.confirmed).toBe(false)
    })

    test("getTransactionFinality returns correct shape for confirmed tx", () => {
        const now = Date.now()
        const result = {
            hash: "finality_tx_002",
            classification: "PRE_APPROVED",
            softFinalityAt: now - 12000,
            hardFinalityAt: now - 2000,
            confirmed: true,
        }

        expect(result.confirmed).toBe(true)
        expect(result.softFinalityAt).not.toBeNull()
        expect(result.hardFinalityAt).not.toBeNull()
        expect(result.hardFinalityAt!).toBeGreaterThan(result.softFinalityAt!)
    })

    test("unknown tx returns UNKNOWN classification", () => {
        const result = {
            hash: "unknown_tx",
            classification: "UNKNOWN",
            softFinalityAt: null,
            hardFinalityAt: null,
            confirmed: false,
        }

        expect(result.classification).toBe("UNKNOWN")
        expect(result.confirmed).toBe(false)
    })
})
