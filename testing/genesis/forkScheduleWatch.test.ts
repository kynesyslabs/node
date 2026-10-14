import { describe, it, expect } from "bun:test"
import { planScheduleCheck } from "src/libs/peer/routines/forkScheduleWatch"

const cfg = (...heights: Array<number | null>) =>
    Object.fromEntries(heights.map((h, i) => [`f${i}`, { activationHeight: h }]))

describe("when the fork schedule is compared against peers", () => {
    it("every 100 blocks when nothing is scheduled ahead", () => {
        const c = cfg(0, null)
        expect(planScheduleCheck(100, c)).toEqual({ due: true, inWindow: false, nearest: null })
        expect(planScheduleCheck(101, c).due).toBe(false)
        expect(planScheduleCheck(110, c).due).toBe(false)
    })

    it("every 10 blocks, as an error, once within 50 blocks of the nearest scheduled height", () => {
        const c = cfg(0, 1000, 5000)
        expect(planScheduleCheck(940, c)).toEqual({ due: false, inWindow: false, nearest: 1000 })
        expect(planScheduleCheck(950, c)).toEqual({ due: true, inWindow: true, nearest: 1000 })
        expect(planScheduleCheck(955, c).due).toBe(false)
        expect(planScheduleCheck(990, c)).toEqual({ due: true, inWindow: true, nearest: 1000 })
    })

    it("picks the nearest of several scheduled heights and ignores ones already passed", () => {
        const c = cfg(5, 2000, 1200)
        expect(planScheduleCheck(1160, c).nearest).toBe(1200)
        expect(planScheduleCheck(1210, c).nearest).toBe(2000)
    })

    it("stops escalating after the last scheduled height", () => {
        const c = cfg(1000)
        expect(planScheduleCheck(1001, c)).toEqual({ due: false, inWindow: false, nearest: null })
        expect(planScheduleCheck(1100, c)).toEqual({ due: true, inWindow: false, nearest: null })
    })
})
