/**
 * Petri Consensus — ContinuousForge state lifecycle tests
 *
 * Tests the forge state machine: start, stop, pause, resume, reset.
 * Does NOT test the actual forge round (requires DB + network) —
 * that's covered by integration tests in Phase 6.
 */
import { describe, expect, test, afterEach } from "bun:test"
import { ContinuousForge } from "@/libs/consensus/petri/forge/continuousForge"
import { DEFAULT_PETRI_CONFIG } from "@/libs/consensus/petri/types/petriConfig"

// Use a long interval so no rounds actually fire during tests
const testConfig = { ...DEFAULT_PETRI_CONFIG, forgeIntervalMs: 60000 }

describe("ContinuousForge state lifecycle", () => {
    let forge: ContinuousForge

    afterEach(() => {
        // Always stop to clear timers
        forge?.stop()
    })

    test("initial state is not running", () => {
        forge = new ContinuousForge(testConfig)
        const state = forge.getState()
        expect(state.isRunning).toBe(false)
        expect(state.isPaused).toBe(false)
        expect(state.currentRound).toBe(0)
    })

    test("start sets running state", () => {
        forge = new ContinuousForge(testConfig)
        forge.start([]) // empty shard for state test
        const state = forge.getState()
        expect(state.isRunning).toBe(true)
        expect(state.isPaused).toBe(false)
    })

    test("stop clears running state", () => {
        forge = new ContinuousForge(testConfig)
        forge.start([])
        forge.stop()
        const state = forge.getState()
        expect(state.isRunning).toBe(false)
    })

    test("double start is ignored", () => {
        forge = new ContinuousForge(testConfig)
        forge.start([])
        forge.start([]) // should not throw or reset
        expect(forge.getState().isRunning).toBe(true)
    })

    test("pause and resume", () => {
        forge = new ContinuousForge(testConfig)
        forge.start([])

        forge.pause()
        expect(forge.getState().isPaused).toBe(true)

        forge.resume()
        expect(forge.getState().isPaused).toBe(false)
    })

    test("reset clears round counter and deltas", () => {
        forge = new ContinuousForge(testConfig)
        forge.start([])

        // Manually check getCurrentDeltas returns empty
        expect(forge.getCurrentDeltas()).toEqual({})

        forge.reset()
        const state = forge.getState()
        expect(state.currentRound).toBe(0)
        expect(forge.getCurrentDeltas()).toEqual({})
    })

    test("getCurrentDeltas returns copy (not reference)", () => {
        forge = new ContinuousForge(testConfig)
        const deltas1 = forge.getCurrentDeltas()
        const deltas2 = forge.getCurrentDeltas()
        expect(deltas1).toEqual(deltas2)
        expect(deltas1).not.toBe(deltas2) // different object references
    })
})
