/**
 * A received DemoScript is logged by its step count and step contexts only:
 * its steps carry signed XM payloads and web2 requests. At most 10 contexts
 * are logged, and `steps` that is not an object counts as no steps. A failed script logs
 * only the error's kind, and a step logs its context and description as
 * escaped values.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test"

const logged: string[] = []
const record = (...args: unknown[]) => {
    logged.push(
        args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    )
}
const recordingLog = {
    debug: record,
    info: record,
    warn: record,
    warning: record,
    error: record,
    only: record,
}
mock.module("src/utilities/logger", () => ({ __esModule: true, default: recordingLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: recordingLog }))

// The steps themselves are not run here, only the request is received.
const passThrough = async (script: unknown) => [script, []]
let processOperations: (script: unknown) => Promise<unknown[]> = passThrough
mock.module("./processOperations", () => ({
    processOperations: (script: unknown) => processOperations(script),
}))
// handleStep is called directly with an unknown context: none of these run.
mock.module("../handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest: jest.fn() }))
mock.module("../handleNativeRequest", () => ({ __esModule: true, default: jest.fn() }))
mock.module("../handleL2PS", () => ({ __esModule: true, default: jest.fn() }))

const { default: handleDemosWorkRequest } = await import(
    "./handleDemosWorkRequest"
)
const { default: handleStep } = await import("./handleStep")

const SIGNED = "0x02f8cc33signedxmpayload"
const API_KEY = "web2secretkey"

function script(): any {
    return {
        operationOrder: ["op1"],
        operations: { op1: { operationType: "base", work: ["s1", "s2"] } },
        steps: {
            s1: {
                id: "s1",
                context: "xm",
                description: "pay",
                content: {
                    operations: {
                        a: {
                            chain: "eth",
                            subchain: "sepolia",
                            is_evm: true,
                            task: { type: "pay", signedPayloads: [SIGNED] },
                        },
                    },
                    operations_order: ["a"],
                },
                output: {},
            },
            s2: {
                id: "s2",
                context: "web2",
                description: "fetch",
                content: { raw: { url: `https://api.example/?key=${API_KEY}` } },
                output: {},
            },
        },
    }
}

afterEach(() => {
    logged.length = 0
    processOperations = passThrough
})

describe("DemoScript request logging", () => {
    it("logs the step count and contexts, and no step content", async () => {
        const res = await handleDemosWorkRequest(script())

        expect(res.result).toBe(200)
        const all = logged.join("\n")
        expect(all).not.toContain("signedxmpayload")
        expect(all).not.toContain(API_KEY)
        expect(all).toContain("2 step(s): \"xm\", \"web2\"")
    })

    it("logs each step context as one escaped value of at most 64 characters", async () => {
        const forged = script()
        forged.steps.s1.context = "xm\nforged " + "x".repeat(1000)
        forged.steps.s2.context = 7

        await handleDemosWorkRequest(forged)

        const lines = logged.filter(line => line.includes("forged"))
        expect(lines).toEqual([
            `2 step(s): "xm\\nforged ${"x".repeat(53)}", number`,
        ])
    })

    it("logs a long string `steps` as no steps, without walking it", async () => {
        const forged = script()
        forged.operationOrder = []
        forged.operations = {}
        forged.steps = "a".repeat(4_000_000)

        const started = performance.now()
        const res = await handleDemosWorkRequest(forged)
        const elapsed = performance.now() - started

        expect(res.result).toBe(200)
        expect(elapsed).toBeLessThan(100)
        expect(logged).toContain("0 step(s): ")
        expect(logged.every(line => line.length < 1000)).toBe(true)
    })

    it("logs the first 10 step contexts and counts the rest", async () => {
        const many = script()
        many.steps = Object.fromEntries(
            Array.from({ length: 1000 }, (_, i) => [`s${i}`, { id: `s${i}`, context: `c${i}` }]),
        )
        const first10 = Array.from({ length: 10 }, (_, i) => `"c${i}"`).join(", ")

        await handleDemosWorkRequest(many)

        expect(logged.filter(line => line.includes("step(s)"))).toEqual([
            `1000 step(s): ${first10}, 990 more`,
        ])
    })

    it("logs only the error kind when the script fails, and returns the full error", async () => {
        processOperations = async () => {
            throw new Error(`step failed for payload ${SIGNED}`)
        }

        const res = await handleDemosWorkRequest(script())

        expect(res.result).toBe(400)
        expect(res.extra).toContain(SIGNED)
        expect(logged.join("\n")).not.toContain("signedxmpayload")
        expect(logged.filter(line => line.includes("Error processing"))).toEqual([
            "[demosWork] [handleDemosWorkRequest] Error processing DemoScript: Error",
        ])
    })
})

describe("DemosWork step logging", () => {
    it("logs the step context and description as escaped values of at most 64 characters", async () => {
        const res = await handleStep({
            id: "s1",
            context: "xm\nforged " + "x".repeat(1000),
            description: "pay\nforged " + "y".repeat(1000),
            content: {},
            output: {},
        } as any)

        expect(res.success).toBe(false)
        expect(logged.filter(line => line.includes("forged"))).toEqual([
            "[demosWork] [handleStep] Handling a step with context: " +
                `"xm\\nforged ${"x".repeat(53)}" and description: ` +
                `"pay\\nforged ${"y".repeat(52)}"`,
        ])
    })

    it("logs a non-string context and description as their type", async () => {
        await handleStep({
            id: "s1",
            context: { forged: true },
            description: 7,
            content: {},
            output: {},
        } as any)

        expect(logged).toContain(
            "[demosWork] [handleStep] Handling a step with context: object and description: number",
        )
    })
})
