/**
 * The operator off switches hold at every way in, not only the tx path: the
 * web2ProxyRequest RPC, a direct XM digest (also used by DemosWork XM steps)
 * and a DemosWork script each refuse with a clear message and make no call.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test"

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("@/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => ({ PROD: false }) },
    getSharedState: { PROD: false },
}))
mock.module("src/libs/network/server_rpc", () => ({
    emptyResponse: { result: 0, response: "", require_reply: false, extra: null },
}))
const createDAHR = jest.fn()
mock.module("src/features/web2/dahr/DAHRFactory", () => ({
    DAHRFactory: { instance: { createDAHR, getDAHR: jest.fn() } },
}))
const xmExecute = jest.fn()
mock.module("src/features/multichain/routines/XMParser", () => ({
    __esModule: true,
    default: { execute: xmExecute, load: jest.fn() },
}))
const processOperations = jest.fn()
mock.module("src/libs/network/routines/transactions/demosWork/processOperations", () => ({
    processOperations,
}))

const { handleWeb2ProxyRequest } = await import(
    "./routines/transactions/handleWeb2ProxyRequest"
)
const { default: MultichainDispatcher } = await import(
    "src/features/multichain/XMDispatcher"
)
const { default: handleDemosWorkRequest } = await import(
    "./routines/transactions/demosWork/handleDemosWorkRequest"
)
const { Config } = await import("src/config")

function off(name: string) {
    process.env[name] = "false"
    Config.resetInstance()
}

afterEach(() => {
    for (const k of ["XM_ENABLED", "DEMOSWORK_ENABLED", "WEB2_ENABLED"]) delete process.env[k]
    Config.resetInstance()
})

describe("operator off switches at every entry", () => {
    it("WEB2_ENABLED=false refuses the web2ProxyRequest RPC", async () => {
        off("WEB2_ENABLED")
        const res = await handleWeb2ProxyRequest({
            web2Request: { raw: { action: "create" } } as any,
        })
        expect(res.result).toBe(403)
        expect(String(res.extra)).toContain("WEB2_ENABLED")
        expect(createDAHR).not.toHaveBeenCalled()
    })

    it("XM_ENABLED=false refuses an XM script without executing it", async () => {
        off("XM_ENABLED")
        const res = await MultichainDispatcher.digest({ operations: {} } as any)
        expect(res.success).toBe(false)
        expect(res.message).toContain("XM_ENABLED")
        expect(xmExecute).not.toHaveBeenCalled()
    })

    it("DEMOSWORK_ENABLED=false refuses a DemosWork script", async () => {
        off("DEMOSWORK_ENABLED")
        const res = await handleDemosWorkRequest({ operations: {} } as any)
        expect(res.result).toBe(403)
        expect(String(res.extra)).toContain("DEMOSWORK_ENABLED")
        expect(processOperations).not.toHaveBeenCalled()
    })
})
