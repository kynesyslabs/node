import { describe, it, expect, spyOn } from "bun:test"
import {
    planScheduleCheck,
    mapWithLimit,
    onBlockInserted,
} from "src/libs/peer/routines/forkScheduleWatch"
import GCR from "src/libs/blockchain/gcr/gcr"

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

describe("comparing against many peers", () => {
    it("never has more than the limit in flight and visits every item", async () => {
        let inFlight = 0
        let peak = 0
        const seen: number[] = []
        await mapWithLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async n => {
            inFlight++
            peak = Math.max(peak, inFlight)
            await new Promise(r => setTimeout(r, 5))
            seen.push(n)
            inFlight--
        })
        expect(peak).toBe(4)
        expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })

    it("does nothing for no items", async () => {
        let ran = 0
        await mapWithLimit([], 4, async () => {
            ran++
        })
        expect(ran).toBe(0)
    })
})

describe("rounds that become due while one is still running", () => {
    it("keeps only the latest one and runs it after the current round", async () => {
        const { getSharedState } = await import("@/utilities/sharedState")
        const PeerManager = (await import("src/libs/peer/PeerManager")).default
        const saved = {
            forkConfig: getSharedState.forkConfig,
            chainId: getSharedState.chainId,
        }
        getSharedState.forkConfig = {
            signatureDomain: { activationHeight: 1000 },
        } as never
        getSharedState.chainId = 1

        const releases: Array<() => void> = []
        let asked = 0
        const peer = {
            identity: "peer",
            connection: { string: "http://peer" },
            call: () => {
                asked++
                return new Promise(resolve => {
                    releases.push(() => resolve({ result: 503 }))
                })
            },
        }
        const getPeers = spyOn(PeerManager, "getInstance").mockReturnValue({
            getPeers: () => [peer],
        } as never)
        // The watch compares staked validators only, so the peer must be in the set.
        const validators = spyOn(GCR, "getGCRValidatorsAtBlock").mockResolvedValue([
            { address: "peer" },
        ] as never)

        try {
            const first = onBlockInserted(950)
            await waitFor(() => asked === 1)
            await onBlockInserted(960)
            await onBlockInserted(970)
            await onBlockInserted(971) // not due: must not queue
            expect(asked).toBe(1)
            releases.shift()!()
            await waitFor(() => asked === 2)
            releases.shift()!()
            await first
            expect(asked).toBe(2)
        } finally {
            getPeers.mockRestore()
            validators.mockRestore()
            getSharedState.forkConfig = saved.forkConfig
            getSharedState.chainId = saved.chainId
        }
        // The first dynamic import of the peer stack is slow on a cold run.
    }, 30000)
})

async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) {
        await new Promise(r => setTimeout(r, 10))
    }
    expect(cond()).toBe(true)
}
