import { afterEach, beforeEach, describe, expect, it } from "bun:test"

const keys = [
    "PROD",
    "DEBUG_ASSERTIONS_ENABLED",
    "EXPOSED_URL",
    "GIT_COMMIT",
] as const
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))

// Production config requires build provenance, read once at import.
process.env.GIT_COMMIT ||= "a".repeat(40)
const { loadConfig } = await import("./loader")

beforeEach(() => {
    delete process.env.PROD
    delete process.env.DEBUG_ASSERTIONS_ENABLED
    process.env.EXPOSED_URL = "http://203.0.114.7:53550"
})

afterEach(() => {
    for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
    }
})

describe("debug assertions in production", () => {
    for (const prod of ["true", "1"]) {
        for (const assertions of ["true", "1"]) {
            it(`refuses PROD=${prod} with DEBUG_ASSERTIONS_ENABLED=${assertions}`, () => {
                process.env.PROD = prod
                process.env.DEBUG_ASSERTIONS_ENABLED = assertions
                expect(() => loadConfig()).toThrow(
                    /DEBUG_ASSERTIONS_ENABLED is refused with PROD=true; set DEBUG_ASSERTIONS_ENABLED=false/,
                )
            })
        }
    }

    for (const assertions of [undefined, "", "false", "0"]) {
        it(`allows production with assertions ${JSON.stringify(assertions)}`, () => {
            process.env.PROD = "true"
            if (assertions !== undefined) {
                process.env.DEBUG_ASSERTIONS_ENABLED = assertions
            }
            const config = loadConfig()
            expect(config.core.prod).toBe(true)
            expect(config.debug.assertionsEnabled).toBe(false)
        })
    }

    for (const prod of [undefined, "", "false", "0"]) {
        it(`allows debug assertions with PROD=${JSON.stringify(prod)}`, () => {
            if (prod !== undefined) process.env.PROD = prod
            process.env.DEBUG_ASSERTIONS_ENABLED = "true"
            const config = loadConfig()
            expect(config.core.prod).toBe(false)
            expect(config.debug.assertionsEnabled).toBe(true)
        })
    }
})
