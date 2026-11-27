/**
 * A DemosWork script runs every operation and its tx records the run; a
 * failed step is reported in its operation's result and in `extra`.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))

let xmReply: any = { success: true, message: "all_ops_ok", results: {} }
const digest = jest.fn(async () => xmReply)
mock.module("src/features/multichain/XMDispatcher", () => ({ __esModule: true, default: { digest } }))
let web2Status = 200
const handleWeb2ProxyRequest = jest.fn(async () => ({ result: web2Status, response: {}, extra: null }))
mock.module("../handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest }))
let nativeStatus = 200
const handleNativeRequest = jest.fn(async () => ({ result: nativeStatus }))
mock.module("../handleNativeRequest", () => ({ __esModule: true, default: handleNativeRequest }))
let l2psStatus = 200
const handleL2PS = jest.fn(async () => ({ result: l2psStatus }))
mock.module("../handleL2PS", () => ({ __esModule: true, default: handleL2PS }))

const { default: handleDemosWorkRequest } = await import("./handleDemosWorkRequest")

function script(...ops: string[][]): any {
    const steps: Record<string, any> = {}
    const operations: Record<string, any> = {}
    ops.forEach((contexts, i) => {
        const ids = contexts.map((context, j) => {
            const id = `s${i}_${j}`
            steps[id] = { id, context, description: id, content: {}, output: {} }
            return id
        })
        operations[`op${i}`] = { operationType: "base", id: ids }
    })
    return { operationOrder: Object.keys(operations), operations, steps }
}

beforeEach(() => {
    xmReply = { success: true, message: "all_ops_ok", results: {} }
    web2Status = 200
    nativeStatus = 200
    l2psStatus = 200
    for (const f of [digest, handleWeb2ProxyRequest, handleNativeRequest, handleL2PS]) f.mockClear()
})

describe("handleDemosWorkRequest", () => {
    it("returns 200 when every step succeeded", async () => {
        const reply = await handleDemosWorkRequest(script(["xm", "web2"], ["native", "l2ps"]))
        expect(reply.result).toBe(200)
        expect(reply.response.operationsResults.every((o: any) => o.success)).toBe(true)
    })

    it("runs every operation after a failed one and reports the failure", async () => {
        xmReply = { success: false, message: "all_ops_failed", results: {} }
        const reply = await handleDemosWorkRequest(script(["xm"], ["web2"]))
        expect(reply.result).toBe(200)
        expect(String(reply.extra)).toContain("all_ops_failed")
        expect(reply.response.operationsResults).toHaveLength(2)
        expect(reply.response.operationsResults.map((o: any) => o.success)).toEqual([false, true])
        expect(handleWeb2ProxyRequest).toHaveBeenCalledTimes(1)
    })

    it("treats a partly executed XM step as done", async () => {
        xmReply = { success: true, message: "partial_success", results: { a: { result: "success", hash: "0x1" } } }
        const reply = await handleDemosWorkRequest(script(["xm"]))
        expect(reply.result).toBe(200)
        expect(reply.response.operationsResults[0].success).toBe(true)
    })

    it("reports a non-200 web2 step as failed", async () => {
        web2Status = 502
        const reply = await handleDemosWorkRequest(script(["web2", "native"]))
        expect(reply.result).toBe(200)
        expect(reply.response.operationsResults[0].success).toBe(false)
    })

    for (const [context, set] of [
        ["native", () => (nativeStatus = 400)],
        ["l2ps", () => (l2psStatus = 400)],
    ] as const) {
        it(`reports a non-200 ${context} step as failed`, async () => {
            set()
            const reply = await handleDemosWorkRequest(script([context]))
            expect(reply.result).toBe(200)
            expect(reply.response.operationsResults[0].success).toBe(false)
            expect(String(reply.extra)).toContain(`${context} step failed`)
        })
    }

    it("reports an unimplemented conditional operation without refusing the run", async () => {
        const s = script(["native"])
        s.operations.op0.operationType = "conditional"
        const reply = await handleDemosWorkRequest(s)
        expect(reply.result).toBe(200)
        expect(reply.response.operationsResults[0].success).toBe(false)
    })
})
