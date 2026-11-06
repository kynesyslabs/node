/**
 * Boot connect to Postgres: a database that comes up a few seconds after the
 * node must not kill it, and a wrong configuration must still stop it at
 * once. No database is used; `dataSource.initialize` is replaced.
 */

import { afterEach, describe, expect, it } from "bun:test"
import Datasource, { dataSource } from "src/model/datasource"
import { connectWithRetry, isDbStartupRace } from "src/model/dbPreflight"

const refused = () =>
    Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" })
const startingUp = () =>
    Object.assign(new Error("the database system is starting up"), { code: "57P03" })
const badPassword = () =>
    Object.assign(new Error('password authentication failed for user "demos"'), { code: "28P01" })

describe("isDbStartupRace", () => {
    it("retries an unreachable or starting server only", () => {
        expect(isDbStartupRace(refused())).toBe(true)
        expect(isDbStartupRace(startingUp())).toBe(true)
        expect(isDbStartupRace(new Error("timeout exceeded when trying to connect"))).toBe(true)
        expect(isDbStartupRace(badPassword())).toBe(false)
        expect(isDbStartupRace(new Error('relation "blocks" does not exist'))).toBe(false)
    })
})

describe("connectWithRetry", () => {
    const fast = { attempts: 5, baseDelayMs: 100, maxDelayMs: 250 }

    it("waits with a capped exponential backoff until the server answers", async () => {
        const delays: number[] = []
        let calls = 0
        const result = await connectWithRetry(
            async () => {
                calls++
                if (calls < 4) throw calls === 1 ? refused() : startingUp()
                return "up"
            },
            { ...fast, sleep: async ms => void delays.push(ms) },
        )
        expect(result).toBe("up")
        expect(delays).toEqual([100, 200, 250])
    })

    it("gives up after the last attempt with the driver's error", async () => {
        let calls = 0
        const run = connectWithRetry(
            async () => {
                calls++
                throw refused()
            },
            { ...fast, sleep: async () => {} },
        )
        await expect(run).rejects.toThrow("ECONNREFUSED")
        expect(calls).toBe(5)
    })

    it("does not retry a configuration error", async () => {
        let calls = 0
        const run = connectWithRetry(
            async () => {
                calls++
                throw badPassword()
            },
            { ...fast, sleep: async () => {} },
        )
        await expect(run).rejects.toThrow("password authentication failed")
        expect(calls).toBe(1)
    })
})

describe("Datasource.getInstance", () => {
    const original = dataSource.initialize.bind(dataSource)
    afterEach(() => {
        dataSource.initialize = original
    })

    it("survives a database that answers only on the third try, with one connect for concurrent callers", async () => {
        let calls = 0
        dataSource.initialize = async () => {
            calls++
            if (calls < 3) throw refused()
            return dataSource
        }
        const [a, b] = await Promise.all([Datasource.getInstance(), Datasource.getInstance()])
        expect(a).toBe(b)
        expect(a.getDataSource()).toBe(dataSource)
        expect(calls).toBe(3)
    })
})
