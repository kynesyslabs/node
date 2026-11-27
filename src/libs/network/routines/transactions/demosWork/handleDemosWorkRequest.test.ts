/**
 * A DemosWork script is reported as done only when every operation and step
 * succeeded; a failed step fails the request, and the operations after it do
 * not run.
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

    it("fails on a partly executed XM step and does not run later operations", async () => {
        xmReply = { success: false, message: "partial_ops_ok", results: { a: { result: "success", hash: "0x1" } } }
        const reply = await handleDemosWorkRequest(script(["xm"], ["web2"]))
        expect(reply.result).not.toBe(200)
        expect(String(reply.extra)).toContain("partial_ops_ok")
        expect(reply.response.operationsResults).toHaveLength(1)
        expect(handleWeb2ProxyRequest).not.toHaveBeenCalled()
    })

    it("fails on a non-200 web2 step and skips the rest of its operation", async () => {
        web2Status = 502
        const reply = await handleDemosWorkRequest(script(["web2", "native"]))
        expect(reply.result).not.toBe(200)
        expect(handleNativeRequest).not.toHaveBeenCalled()
    })

    for (const [context, set] of [
        ["native", () => (nativeStatus = 400)],
        ["l2ps", () => (l2psStatus = 400)],
    ] as const) {
        it(`fails on a non-200 ${context} step`, async () => {
            set()
            const reply = await handleDemosWorkRequest(script([context]))
            expect(reply.result).not.toBe(200)
            expect(String(reply.extra)).toContain(`${context} step failed`)
        })
    }

    it("fails on an unimplemented conditional operation", async () => {
        const s = script(["native"])
        s.operations.op0.operationType = "conditional"
        const reply = await handleDemosWorkRequest(s)
        expect(reply.result).not.toBe(200)
    })
})
