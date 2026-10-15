/**
 * The cap on a subnet's executed backlog.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const warning = jest.fn()
const error = jest.fn()

mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning, error, only: jest.fn() },
}))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({ __esModule: true, default: {} }))

const { ExecutedBacklogGuard } = await import("./executedBacklogGuard")

let clock = 1_000_000
let backlog: Record<string, number>
let counts: number

function guard(cap = 100) {
    return new ExecutedBacklogGuard({
        cap,
        retryAfterMs: 10_000,
        now: () => clock,
        countExecuted: async uid => {
            counts++
            return backlog[uid] ?? 0
        },
    })
}

beforeEach(() => {
    clock = 1_000_000
    backlog = {}
    counts = 0
    warning.mockClear()
    error.mockClear()
})

describe("executed backlog cap", () => {
    it("admits while the backlog is below the cap", async () => {
        backlog.a = 99
        expect((await guard().admit("a")).admitted).toBe(true)
    })

    it("refuses at the cap and says when to retry", async () => {
        backlog.a = 100
        expect(await guard().admit("a")).toEqual({ admitted: false, count: 100, cap: 100, retryAfterMs: 10_000 })
    })

    it("counts its own admissions, so a burst cannot run past the cap", async () => {
        backlog.a = 90
        const g = guard()
        const outcomes = []
        for (let i = 0; i < 30; i++) outcomes.push((await g.admit("a")).admitted)

        expect(outcomes.filter(Boolean)).toHaveLength(10)
        expect(counts).toBe(1)
    })

    it("reads the count once per interval, not once per message", async () => {
        const g = guard(1_000_000)
        for (let i = 0; i < 500; i++) await g.admit("a")
        expect(counts).toBe(1)
    })

    it("reads the count again after the interval and lets a drained subnet through", async () => {
        backlog.a = 100
        const g = guard()
        expect((await g.admit("a")).admitted).toBe(false)

        backlog.a = 10
        expect((await g.admit("a")).admitted).toBe(false)
        clock += 3001
        expect((await g.admit("a")).admitted).toBe(true)
        expect(counts).toBe(2)
    })

    it("tracks subnets separately", async () => {
        backlog.a = 100
        backlog.b = 5
        const g = guard()
        expect((await g.admit("a")).admitted).toBe(false)
        expect((await g.admit("b")).admitted).toBe(true)
    })

    it("does not limit anything when the cap is 0", async () => {
        backlog.a = 10_000_000
        expect((await guard(0).admit("a")).admitted).toBe(true)
        expect(counts).toBe(0)
    })

    it("lets messages through when the count cannot be read", async () => {
        const g = new ExecutedBacklogGuard({
            cap: 1,
            retryAfterMs: 1,
            now: () => clock,
            countExecuted: async () => {
                throw new Error("db down")
            },
        })
        expect((await g.admit("a")).admitted).toBe(true)
    })

    it("warns once on crossing half the cap and again only after dropping below it", async () => {
        backlog.a = 60
        const g = guard()
        await g.admit("a")
        await g.admit("a")
        expect(warning).toHaveBeenCalledTimes(1)

        backlog.a = 10
        clock += 3001
        await g.admit("a")
        backlog.a = 70
        clock += 3001
        await g.admit("a")
        expect(warning).toHaveBeenCalledTimes(2)
    })

    it("logs an error at the cap at most once a minute per subnet", async () => {
        backlog.a = 100
        const g = guard()
        for (let i = 0; i < 50; i++) await g.admit("a")
        expect(error).toHaveBeenCalledTimes(1)

        clock += 61_000
        await g.admit("a")
        expect(error).toHaveBeenCalledTimes(2)
    })

    it("keeps refusing a subnet at its cap when a later count fails", async () => {
        backlog.a = 100
        let failing = false
        const g = new ExecutedBacklogGuard({
            cap: 100,
            retryAfterMs: 1,
            now: () => clock,
            countExecuted: async uid => {
                if (failing) throw new Error("db down")
                return backlog[uid] ?? 0
            },
        })
        expect((await g.admit("a")).admitted).toBe(false)

        failing = true
        for (let window = 0; window < 3; window++) {
            clock += 3001
            expect((await g.admit("a")).admitted).toBe(false)
        }

        failing = false
        backlog.a = 5
        clock += 3001
        expect((await g.admit("a")).admitted).toBe(true)
    })
})
