import { describe, expect, it } from "bun:test"
import { RetentionSweepGate } from "./retentionSweepGate"

const HOUR = 60 * 60 * 1000

describe("RetentionSweepGate under a hostile clock and many callers", () => {
    it("grants one sweep to a burst of callers in the same instant", () => {
        const gate = new RetentionSweepGate(HOUR, () => 1_700_000_000_000)
        const grants = Array.from({ length: 1000 }, () => gate.due()).filter(Boolean)

        expect(grants).toHaveLength(1)
    })

    it("grants one sweep to callers racing across microtasks", async () => {
        const gate = new RetentionSweepGate(HOUR, () => 1_700_000_000_000)
        const results = await Promise.all(
            Array.from({ length: 50 }, async () => {
                await Promise.resolve()
                return gate.due()
            }),
        )

        expect(results.filter(Boolean)).toHaveLength(1)
    })

    it("sweeps again within an interval of a clock that was stepped back", () => {
        // An NTP step or a manual correction must not silence retention for as
        // long as the step was large: the promise is to delete on schedule.
        let t = 1_700_000_000_000
        const gate = new RetentionSweepGate(HOUR, () => t)
        expect(gate.due()).toBe(true)

        t -= 10 * 24 * HOUR
        expect(gate.due()).toBe(true)
        t += 10_000
        expect(gate.due()).toBe(false)
        t += HOUR
        expect(gate.due()).toBe(true)
    })

    it("a clock that stops is never due twice", () => {
        const gate = new RetentionSweepGate(HOUR, () => 5)
        expect(gate.due()).toBe(true)
        for (let i = 0; i < 100; i++) expect(gate.due()).toBe(false)
    })

    it("a clock that yields NaN does not lock the gate shut", () => {
        let t: number = 1_700_000_000_000
        const gate = new RetentionSweepGate(HOUR, () => t)
        expect(gate.due()).toBe(true)

        t = Number.NaN
        expect(gate.due()).toBe(false)
        t = 1_700_000_000_000 + 10_000
        expect(gate.due()).toBe(false)
        t = 1_700_000_000_000 + HOUR
        expect(gate.due()).toBe(true)
    })

    it("an interval of zero grants every call", () => {
        const gate = new RetentionSweepGate(0, () => 1)
        expect([gate.due(), gate.due(), gate.due()]).toEqual([true, true, true])
    })

    it("the exact boundary is granted and one millisecond short is not", () => {
        let t = 0
        const gate = new RetentionSweepGate(HOUR, () => t)
        gate.due()
        t = HOUR - 1
        expect(gate.due()).toBe(false)
        t = HOUR
        expect(gate.due()).toBe(true)
    })
})
