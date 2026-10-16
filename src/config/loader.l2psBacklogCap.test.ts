import { afterEach, describe, expect, it } from "bun:test"
import { loadConfig } from "./loader"

const KEYS = ["L2PS_MEMPOOL_MAX_EXECUTED_PER_SUBNET", "L2PS_MIN_BATCH_SIZE"] as const
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
})
