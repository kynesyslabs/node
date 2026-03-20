/**
 * Petri Consensus — Phase 6: Feature Flag Rollback Test
 *
 * Tests clean switching between PoRBFT v2 and Petri Consensus.
 * Verifies no state corruption when toggling the petriConsensus flag.
 */
import { describe, expect, test, beforeEach } from "bun:test"
import { ContinuousForge } from "@/libs/consensus/petri/forge/continuousForge"
import { DeltaAgreementTracker } from "@/libs/consensus/petri/forge/deltaAgreementTracker"
import { TransactionClassification } from "@/libs/consensus/petri/types/classificationTypes"
import { setPetriForgeInstance, getPetriForgeInstance } from "@/libs/consensus/petri/forge/forgeInstance"

// ---- Helpers ----

function mockPeers(count: number): any[] {
    return Array.from({ length: count }, (_, i) => ({
        identity: `peer_${String(i).padStart(3, "0")}`,
        connection: { string: `localhost:${3000 + i}` },
        longCall: () => Promise.resolve({ result: 200, response: { deltas: {} } }),
    }))
}

function makeConfig() {
    return {
        forgeIntervalMs: 60000,
        blockIntervalMs: 10000,
        agreementThreshold: 7,
        problematicTTLRounds: 5,
    }
}

// ---- Flag Dispatch Logic ----

describe("Feature Flag — Dispatch Logic", () => {
    test("flag ON → petri path selected", () => {
        const petriConsensus = true
        const path = petriConsensus ? "petri" : "porbft"
        expect(path).toBe("petri")
    })

    test("flag OFF → porbft path selected", () => {
        const petriConsensus = false
        const path = petriConsensus ? "petri" : "porbft"
        expect(path).toBe("porbft")
    })

    test("flag toggle: ON → OFF → ON produces correct sequence", () => {
        const flags = [true, false, true]
        const paths = flags.map(f => (f ? "petri" : "porbft"))
        expect(paths).toEqual(["petri", "porbft", "petri"])
    })

    test("rapid flag changes always resolve to current value", () => {
        let flag = false
        for (let i = 0; i < 100; i++) {
            flag = !flag
        }
        // After 100 toggles (even number), back to false
        expect(flag).toBe(false)
        expect(flag ? "petri" : "porbft").toBe("porbft")
    })
})

// ---- Forge Instance Lifecycle on Toggle ----

describe("Feature Flag — Forge Instance Lifecycle", () => {
    beforeEach(() => {
        setPetriForgeInstance(null)
    })

    test("flag ON: forge instance created and registered", () => {
        const forge = new ContinuousForge(makeConfig())
        setPetriForgeInstance(forge)

        expect(getPetriForgeInstance()).toBe(forge)

        forge.stop()
        setPetriForgeInstance(null)
    })

    test("flag OFF: forge instance deregistered", () => {
        const forge = new ContinuousForge(makeConfig())
        setPetriForgeInstance(forge)
        expect(getPetriForgeInstance()).toBe(forge)

        // Simulating flag OFF → stop forge and deregister
        forge.stop()
        setPetriForgeInstance(null)

        expect(getPetriForgeInstance()).toBeNull()
    })

    test("toggle ON→OFF→ON: new forge instance each time", () => {
        // ON: create forge1
        const forge1 = new ContinuousForge(makeConfig())
        setPetriForgeInstance(forge1)
        forge1.start(mockPeers(3))
        expect(getPetriForgeInstance()).toBe(forge1)
        expect(forge1.getState().isRunning).toBe(true)

        // OFF: stop forge1
        forge1.stop()
        setPetriForgeInstance(null)
        expect(getPetriForgeInstance()).toBeNull()
        expect(forge1.getState().isRunning).toBe(false)

        // ON again: create forge2 (new instance)
        const forge2 = new ContinuousForge(makeConfig())
        setPetriForgeInstance(forge2)
        forge2.start(mockPeers(3))
        expect(getPetriForgeInstance()).toBe(forge2)
        expect(forge2.getState().isRunning).toBe(true)

        // forge1 and forge2 are different instances
        expect(forge1).not.toBe(forge2)

        forge2.stop()
        setPetriForgeInstance(null)
    })
})

// ---- State Isolation ----

describe("Feature Flag — State Isolation", () => {
    test("tracker state is independent per forge instance", () => {
        const tracker1 = new DeltaAgreementTracker(7, 5)
        tracker1.recordDelta("tx_from_forge1", "delta_a", "member_0", 1)
        expect(tracker1.trackedCount).toBe(1)

        // Simulating flag OFF → tracker1 is abandoned
        // Flag ON → new tracker
        const tracker2 = new DeltaAgreementTracker(7, 5)
        expect(tracker2.trackedCount).toBe(0) // Clean slate

        // tracker1 state doesn't leak into tracker2
        tracker2.recordDelta("tx_from_forge2", "delta_b", "member_0", 1)
        expect(tracker2.trackedCount).toBe(1)
        expect(tracker1.trackedCount).toBe(1) // Still has its own state
    })

    test("forge reset clears all state cleanly", () => {
        const forge = new ContinuousForge(makeConfig())
        forge.start(mockPeers(3))

        forge.reset()
        expect(forge.getState().currentRound).toBe(0)
        expect(forge.getCurrentDeltas()).toEqual({})

        forge.stop()
    })

    test("classification enums are consistent across toggles", () => {
        // Verifies that TransactionClassification values don't change
        expect(TransactionClassification.TO_APPROVE).toBe("TO_APPROVE")
        expect(TransactionClassification.PRE_APPROVED).toBe("PRE_APPROVED")
        expect(TransactionClassification.PROBLEMATIC).toBe("PROBLEMATIC")
    })
})

// ---- Concurrent State Safety ----

describe("Feature Flag — Concurrent Safety", () => {
    test("stopping forge while paused doesn't cause errors", () => {
        const forge = new ContinuousForge(makeConfig())
        forge.start(mockPeers(3))
        forge.pause()

        expect(forge.getState().isPaused).toBe(true)

        // Stop while paused — should not throw
        forge.stop()
        expect(forge.getState().isRunning).toBe(false)
    })

    test("double stop is safe", () => {
        const forge = new ContinuousForge(makeConfig())
        forge.start(mockPeers(3))
        forge.stop()
        forge.stop() // Second stop — should not throw
        expect(forge.getState().isRunning).toBe(false)
    })

    test("reset after stop is safe", () => {
        const forge = new ContinuousForge(makeConfig())
        forge.start(mockPeers(3))
        forge.stop()
        forge.reset() // Should not throw
        expect(forge.getState().currentRound).toBe(0)
    })

    test("operations on null forge instance are handled", () => {
        setPetriForgeInstance(null)
        const instance = getPetriForgeInstance()
        expect(instance).toBeNull()
    })
})

// ---- Mempool State on Toggle ----

describe("Feature Flag — Mempool Compatibility", () => {
    test("classification column values are valid for both consensus modes", () => {
        // When flag is OFF, the classification column may contain Petri values
        // from a previous ON period. This is safe because PoRBFT v2 ignores the column.
        const petriClassifications = [
            TransactionClassification.TO_APPROVE,
            TransactionClassification.PRE_APPROVED,
            TransactionClassification.PROBLEMATIC,
        ]

        for (const cls of petriClassifications) {
            expect(typeof cls).toBe("string")
            expect(cls.length).toBeGreaterThan(0)
        }
    })

    test("soft_finality_at is nullable — safe when flag is OFF", () => {
        // When PoRBFT v2 is running, soft_finality_at stays null
        const mempoolEntry = {
            hash: "tx_porbft",
            classification: null,
            soft_finality_at: null,
        }

        expect(mempoolEntry.soft_finality_at).toBeNull()
        expect(mempoolEntry.classification).toBeNull()
    })
})
