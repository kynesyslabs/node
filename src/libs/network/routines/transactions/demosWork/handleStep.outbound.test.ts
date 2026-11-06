/**
 * When an operator switches XM or web2 off, a DemosWork step of that kind must
 * fail its operation: the refusal is not a result, and the steps after it must
 * not run as if the skipped work had been done.
 */

import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

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

// Shaped like the dispatchers' own refusals when their switch is off.
const digest = jest.fn(async () => ({
    success: false,
    message: "Cross-chain (XM) operations are disabled on this node (XM_ENABLED=false)",
    results: {},
}))
mock.module("src/features/multichain/XMDispatcher", () => ({
    __esModule: true,
    default: { digest },
}))
const handleWeb2ProxyRequest = jest.fn(async () => ({
    result: 403,
    response: null,
    extra: "Web2 (DAHR) requests are disabled on this node (WEB2_ENABLED=false)",
}))
mock.module("../handleWeb2ProxyRequest", () => ({ handleWeb2ProxyRequest }))
const handleNativeRequest = jest.fn(async () => ({ result: 200 }))
mock.module("../handleNativeRequest", () => ({
    __esModule: true,
    default: handleNativeRequest,
}))
mock.module("../handleL2PS", () => ({ __esModule: true, default: jest.fn() }))

const { Config: appConfig } = await import("src/config")
const { processOperations } = await import("./processOperations")

function switchOff(key: "xmEnabled" | "web2Enabled") {
    const real = appConfig.getInstance()
    spyOn(appConfig, "getInstance").mockReturnValue({
        ...real,
        outbound: { ...real.outbound, [key]: false },
    } as any)
}

function script(firstContext: string): any {
    const step = (id: string, context: string) => ({
        id,
        context,
        description: id,
        content: {},
        output: {},
    })
    return {
        operationOrder: ["op1"],
        operations: { op1: { operationType: "base", id: ["s1", "s2"] } },
        steps: { s1: step("s1", firstContext), s2: step("s2", "native") },
    }
}

afterEach(() => {
    jest.restoreAllMocks()
    handleNativeRequest.mockClear()
})

describe("DemosWork steps whose feature is switched off", () => {
    it.each([
        ["xm", "xmEnabled", "XM_ENABLED=false"],
        ["web2", "web2Enabled", "WEB2_ENABLED=false"],
    ] as const)("%s step fails the operation and stops it", async (ctx, key, env) => {
        switchOff(key)
        const [, results] = await processOperations(script(ctx))
        expect(results[0].success).toBe(false)
        expect(results[0].error).toContain(env)
        expect(handleNativeRequest).not.toHaveBeenCalled()
    })

    it("an enabled step still runs and the next step follows", async () => {
        const [, results] = await processOperations(script("native"))
        expect(results[0].success).toBe(true)
        expect(handleNativeRequest).toHaveBeenCalledTimes(2)
    })
})
