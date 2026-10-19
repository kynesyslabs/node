import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { loadConfig } from "./loader"

const KEYS = [
    "L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET",
    "L2PS_MIN_BATCH_SIZE",
    "L2PS_AGGREGATOR_MAX_BATCHES_PER_CYCLE",
    "L2PS_MESSAGING_SEND_RATE",
    "L2PS_MESSAGING_SEND_BURST",
    "L2PS_MESSAGING_BACKLOG_SHARE",
] as const
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))

function withEnv(cap: string, min: string) {
    process.env.L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET = cap
    process.env.L2PS_MIN_BATCH_SIZE = min
}

afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
    }
})

describe("L2PS backlog cap against the minimum batch size", () => {
    it("rejects a positive cap below the minimum batch size and names both values", () => {
        withEnv("5", "10")
        expect(() => loadConfig()).toThrow(/L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET \(5\).*L2PS_MIN_BATCH_SIZE \(10\)/)
    })

    it("accepts a cap equal to the minimum batch size", () => {
        withEnv("10", "10")
        expect(loadConfig().l2ps.mempoolMaxExecutedPerSubnet).toBe(10)
    })

    it("accepts 0, which disables the cap, whatever the minimum batch size", () => {
        withEnv("0", "10")
        expect(loadConfig().l2ps.mempoolMaxExecutedPerSubnet).toBe(0)
    })

    it("rejects a negative cap instead of reading it as no limit", () => {
        withEnv("-1", "1")
        expect(() => loadConfig()).toThrow(/L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET must be 0/)
    })
})

describe("other L2PS limits", () => {
    it("rejects more batches per cycle than the bound allows, and accepts the bound", () => {
        process.env.L2PS_AGGREGATOR_MAX_BATCHES_PER_CYCLE = "101"
        expect(() => loadConfig()).toThrow(/L2PS_AGGREGATOR_MAX_BATCHES_PER_CYCLE must be at most 100/)

        process.env.L2PS_AGGREGATOR_MAX_BATCHES_PER_CYCLE = "100"
        expect(loadConfig().l2ps.aggregatorMaxBatchesPerCycle).toBe(100)
    })

    it("defaults the messaging limits to 5 per second, a burst of 30 and half the backlog", () => {
        const { l2ps } = loadConfig()
        expect([l2ps.messagingSendRate, l2ps.messagingSendBurst, l2ps.messagingBacklogShare]).toEqual([5, 30, 0.5])
    })

    it("rejects a backlog share outside (0, 1] and a negative rate", () => {
        for (const share of ["0", "1.5", "-0.1"]) {
            process.env.L2PS_MESSAGING_BACKLOG_SHARE = share
            expect(() => loadConfig()).toThrow(/L2PS_MESSAGING_BACKLOG_SHARE/)
        }
        delete process.env.L2PS_MESSAGING_BACKLOG_SHARE

        process.env.L2PS_MESSAGING_SEND_RATE = "-1"
        expect(() => loadConfig()).toThrow(/L2PS_MESSAGING_SEND_RATE/)
    })

    it("warns, without failing, when the messaging share is below the batch minimum", () => {
        const warn = spyOn(console, "warn").mockImplementation(() => undefined)
        try {
            withEnv("10", "10")
            process.env.L2PS_MESSAGING_BACKLOG_SHARE = "0.5"
            expect(loadConfig().l2ps.mempoolMaxExecutedPerSubnet).toBe(10)
            expect(warn.mock.calls.some(call => String(call[0]).includes("raised to the batch minimum"))).toBe(true)

            warn.mockClear()
            withEnv("100", "10")
            loadConfig()
            expect(warn.mock.calls.some(call => String(call[0]).includes("raised to the batch minimum"))).toBe(false)
        } finally {
            warn.mockRestore()
        }
    })
})
