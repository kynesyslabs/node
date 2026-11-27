/**
 * A DemosWork script runs one operation per operationOrder entry and one step
 * per entry of a base operation's id list. The node refuses, before any step
 * runs, a script whose lists are not arrays of distinct names, that lists a
 * step id in more than one base operation, or whose base operations add up to
 * more than 64 step runs. Scripts within those bounds run as before.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test"

const quietLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    only: jest.fn(),
}
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))

const digest = jest.fn(async () => ({
    success: false,
    message: "all_ops_failed",
    results: {},
}))
mock.module("src/features/multichain/XMDispatcher", () => ({
    __esModule: true,
    default: { digest },
}))
mock.module("../handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest: jest.fn() }))
const handleNativeRequest = jest.fn(async () => ({ result: 200 }))
mock.module("../handleNativeRequest", () => ({
    __esModule: true,
    default: handleNativeRequest,
}))
mock.module("../handleL2PS", () => ({ __esModule: true, default: jest.fn() }))

const { default: handleDemosWorkRequest } = await import("./handleDemosWorkRequest")
const { demoScriptRefusal } = await import("./scriptLimits")

const step = (id: string, context = "native") => ({
    id,
    context,
    description: id,
    content: {},
    output: {},
})

const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

/** One base operation `op1` running `stepIds`; every listed step is defined. */
function oneOperation(stepIds: unknown, context = "native"): any {
    const steps: Record<string, unknown> = {}
    for (const id of Array.isArray(stepIds) ? stepIds : [...String(stepIds)]) {
        if (typeof id === "string") steps[id] = step(id, context)
    }
    return {
        operationOrder: ["op1"],
        operations: { op1: { operationType: "base", id: stepIds } },
        steps,
    }
}

/** `count` base operations `op<i>`, each running its own step `s<i>` once. */
function manyOperations(count: number): any {
    const stepIds = ids(count)
    return {
        operationOrder: stepIds.map((_, i) => `op${i}`),
        operations: Object.fromEntries(
            stepIds.map((stepId, i) => [`op${i}`, { operationType: "base", id: [stepId] }]),
        ),
        steps: Object.fromEntries(stepIds.map(stepId => [stepId, step(stepId)])),
    }
}

const STEP_LIST_REFUSED =
    "DemosWork script refused: operation step list missing or not distinct"
const STEP_RUNS_REFUSED = "DemosWork script refused: more than 64 step runs"

/**
 * A step list of `length` ids `<prefix><i>` whose entries count every read
 * in `reads.count`.
 */
function countedStepIds(length: number, prefix: string, reads: { count: number }) {
    const stepIds: string[] = new Array(length)
    for (let i = 0; i < length; i++) {
        Object.defineProperty(stepIds, i, {
            enumerable: true,
            get: () => {
                reads.count++
                return `${prefix}${i}`
            },
        })
    }
    return stepIds
}

function expectRefused(res: any, reason?: string) {
    expect(res.result).toBe(400)
    expect(String(res.extra)).toContain("DemosWork script refused")
    if (reason) expect(res.extra).toBe(reason)
    expect(res.response.operationsResults).toEqual([])
    expect(digest).not.toHaveBeenCalled()
    expect(handleNativeRequest).not.toHaveBeenCalled()
}

afterEach(() => {
    digest.mockClear()
    handleNativeRequest.mockClear()
})

describe("DemosWork scripts refused before any step runs", () => {
    it("an operation named twice in operationOrder", async () => {
        const script = oneOperation(["s1"], "xm")
        script.operationOrder = ["op1", "op1", "op1"]
        expectRefused(await handleDemosWorkRequest(script))
    })

    it("a step id listed twice in one operation", async () => {
        expectRefused(
            await handleDemosWorkRequest(oneOperation(["s1", "s2", "s1"])),
            STEP_LIST_REFUSED,
        )
    })

    it("a step id listed by two operations", async () => {
        const script = manyOperations(2)
        script.operations.op1.id = ["s1", "s0"]
        expectRefused(await handleDemosWorkRequest(script), STEP_LIST_REFUSED)
    })

    it("one step id listed by every operation", async () => {
        const script = manyOperations(64)
        for (const name of script.operationOrder) {
            script.operations[name].id = ["s0"]
        }
        expectRefused(await handleDemosWorkRequest(script), STEP_LIST_REFUSED)
    })

    it("an operationOrder that is not an array", async () => {
        const script = oneOperation(["s1"])
        script.operations.a = script.operations.op1
        script.operationOrder = "aaa"
        expectRefused(await handleDemosWorkRequest(script))
    })

    it.each([
        ["a string", "sss"],
        ["missing", undefined],
        ["an array with a non-string entry", ["s1", ["s1"]]],
    ])("a base operation whose step list is %s", async (_label, stepIds) => {
        expectRefused(
            await handleDemosWorkRequest(oneOperation(stepIds)),
            STEP_LIST_REFUSED,
        )
    })

    it("65 distinct steps in one operation", async () => {
        expectRefused(await handleDemosWorkRequest(oneOperation(ids(65))))
    })

    it("65 operations that each run one step", async () => {
        expectRefused(
            await handleDemosWorkRequest(manyOperations(65)),
            STEP_RUNS_REFUSED,
        )
    })

    it("a step list longer than 64 is refused without reading its entries", () => {
        const reads = { count: 0 }
        const script: any = {
            operationOrder: ["op1"],
            operations: {
                op1: { operationType: "base", id: countedStepIds(10_000, "s", reads) },
            },
            steps: {},
        }
        expect(demoScriptRefusal(script)).toBe(STEP_RUNS_REFUSED)
        expect(reads.count).toBe(0)
    })

    it("a step list that takes the script past 64 is refused without reading its entries", () => {
        const reads = { count: 0 }
        const script: any = {
            operationOrder: ["op1", "op2"],
            operations: {
                op1: { operationType: "base", id: ids(60) },
                op2: { operationType: "base", id: countedStepIds(5, "t", reads) },
            },
            steps: {},
        }
        expect(demoScriptRefusal(script)).toBe(STEP_RUNS_REFUSED)
        expect(reads.count).toBe(0)
    })
})

describe("DemosWork scripts within the limits", () => {
    it("64 distinct steps all run", async () => {
        const res: any = await handleDemosWorkRequest(oneOperation(ids(64)))
        expect(res.result).toBe(200)
        expect(res.response.operationsResults).toHaveLength(1)
        expect(res.response.operationsResults[0].success).toBe(true)
        expect(handleNativeRequest).toHaveBeenCalledTimes(64)
    })

    it("64 operations that each run one step all run", async () => {
        const res: any = await handleDemosWorkRequest(manyOperations(64))
        expect(res.result).toBe(200)
        expect(res.response.operationsResults).toHaveLength(64)
        expect(handleNativeRequest).toHaveBeenCalledTimes(64)
    })

    it("an ordinary two-step script runs both steps in order", async () => {
        digest.mockImplementationOnce(async () => ({
            success: true,
            message: "all_ops_ok",
            results: {},
        }) as any)
        const script = oneOperation(["s1", "s2"])
        script.steps.s1.context = "xm"
        const res: any = await handleDemosWorkRequest(script)
        expect(res.result).toBe(200)
        expect(res.response.operationsResults[0].success).toBe(true)
        expect(digest).toHaveBeenCalledTimes(1)
        expect(handleNativeRequest).toHaveBeenCalledTimes(1)
        expect(res.response.compiledScript.steps.s2.output.s2).toEqual({ result: 200 })
    })

    it("a conditional operation still fails without running a step", async () => {
        const script = oneOperation(["s1"])
        script.operations.op1.operationType = "conditional"
        const res: any = await handleDemosWorkRequest(script)
        expect(res.result).toBe(200)
        expect(res.response.operationsResults[0].success).toBe(false)
        expect(handleNativeRequest).not.toHaveBeenCalled()
    })
})
