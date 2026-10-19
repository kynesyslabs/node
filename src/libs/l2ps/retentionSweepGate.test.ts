import { describe, expect, it } from "bun:test"
import { RetentionSweepGate } from "./retentionSweepGate"

const HOUR = 60 * 60 * 1000

function gateAt(start: number) {
    let t = start
    const gate = new RetentionSweepGate(HOUR, () => t)
    return { gate, advance: (ms: number) => { t += ms } }
}

describe("RetentionSweepGate", () => {
    it("grants the first sweep right away", () => {
        const { gate } = gateAt(1_700_000_000_000)
        expect(gate.due()).toBe(true)
    })

    it("skips cycles inside the interval", () => {
        const { gate, advance } = gateAt(1_700_000_000_000)
        expect(gate.due()).toBe(true)
        for (let i = 0; i < 6; i++) {
            advance(10_000)
            expect(gate.due()).toBe(false)
        }
        advance(HOUR - 60_000 - 1)
        expect(gate.due()).toBe(false)
    })

    it("grants again once the interval has passed", () => {
        const { gate, advance } = gateAt(1_700_000_000_000)
        expect(gate.due()).toBe(true)
        advance(HOUR)
        expect(gate.due()).toBe(true)
        advance(10_000)
        expect(gate.due()).toBe(false)
    })

    it("counts the interval from the grant, so a failed sweep also waits", () => {
        const { gate, advance } = gateAt(1_700_000_000_000)
        expect(gate.due()).toBe(true)
        // The caller's sweep fails here; nothing tells the gate, by design.
        advance(10_000)
        expect(gate.due()).toBe(false)
        advance(HOUR)
        expect(gate.due()).toBe(true)
    })

    it("treats a clock that starts at zero like any other start", () => {
        const { gate, advance } = gateAt(0)
        expect(gate.due()).toBe(true)
        advance(1)
        expect(gate.due()).toBe(false)
        advance(HOUR)
        expect(gate.due()).toBe(true)
    })
})
