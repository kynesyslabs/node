/**
 * An XM script admits its Demos tx only when every operation succeeded. A
 * partial or failed run is refused with each operation's result, so the
 * caller sees which external transactions were sent. Only an explicit
 * success counts: a sent tx names its hash, a read sets its status.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test"

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))

const payReplies: unknown[] = []
mock.module("./routines/executors/pay", () => ({
    __esModule: true,
    default: async () => payReplies.shift(),
    genericJsonRpcPay: async () => payReplies.shift(),
}))

const { xmOpOutcome, xmScriptVerdict } = await import("./xmOutcome")
const { default: XMDispatcher } = await import("./XMDispatcher")

afterEach(() => {
    payReplies.length = 0
})

describe("xmOpOutcome", () => {
    it("counts a sent transaction only with a hash", () => {
        expect(xmOpOutcome("pay", { result: "success", hash: "0xab" })).toBe("ok")
        expect(xmOpOutcome("contract_write", { result: "success", hash: "0xab" })).toBe("ok")
        // the shape the Aptos handler used to return for a hashless answer
        expect(xmOpOutcome("pay", { result: "success", error: { message: "?" } })).toBe("failed")
        expect(xmOpOutcome("pay", { result: "success", hash: "" })).toBe("failed")
        expect(xmOpOutcome("pay", { hash: "0xab" })).toBe("failed")
    })

    it("counts a read by its status", () => {
        expect(xmOpOutcome("contract_read", { result: 42n, status: true })).toBe("ok")
        expect(xmOpOutcome("contract_read", { result: { v: 1 }, status: "success" })).toBe("ok")
        expect(xmOpOutcome("contract_read", { status: "failed", error: "x" })).toBe("failed")
        expect(xmOpOutcome("contract_read", { result: "Failed to read from contract" })).toBe("failed")
        expect(xmOpOutcome("balance_query", { result: "error", status: true })).toBe("failed")
    })

    it("keeps unknown apart and treats empty replies as failures", () => {
        expect(xmOpOutcome("pay", { result: "unknown", hash: "0xab" })).toBe("unknown")
        for (const reply of [null, undefined, "sent", 1]) {
            expect(xmOpOutcome("pay", reply)).toBe("failed")
        }
    })

    it("gives the script verdict", () => {
        expect(xmScriptVerdict(["ok", "ok"])).toBe("all_ops_ok")
        expect(xmScriptVerdict(["ok", "failed"])).toBe("partial_success")
        expect(xmScriptVerdict(["ok", "unknown"])).toBe("partial_success")
        expect(xmScriptVerdict(["unknown"])).toBe("partial_success")
        expect(xmScriptVerdict(["failed", "failed"])).toBe("all_ops_failed")
    })
})

function payOp(): any {
    return {
        chain: "eth",
        subchain: "sepolia",
        is_evm: true,
        rpc: "",
        task: { type: "pay", params: null, signedPayloads: ["0xf86b"] },
    }
}

describe("XMDispatcher.digest", () => {
    const script = { operations: { first: payOp(), second: payOp() }, operations_order: ["first", "second"] }

    it("admits an all-ok script", async () => {
        payReplies.push({ result: "success", hash: "0x01" }, { result: "success", hash: "0x02" })
        const out = await XMDispatcher.digest(script as any)
        expect(out).toMatchObject({ success: true, message: "all_ops_ok" })
    })

    it("admits a partial run so the tx records what was sent", async () => {
        payReplies.push({ result: "success", hash: "0x01" }, { result: "error", error: "nonce too low" })
        const out = await XMDispatcher.digest(script as any)
        expect(out.success).toBe(true)
        expect(out.message).toBe("partial_success")
        expect(out.results.first).toMatchObject({ result: "success", hash: "0x01" })
        expect((out as any).outcomes).toEqual({ first: "ok", second: "failed" })
    })

    it("admits a run with an unknown outcome and keeps its hash", async () => {
        payReplies.push({ result: "success", hash: "0x01" }, { result: "unknown", hash: "0x02" })
        const out = await XMDispatcher.digest(script as any)
        expect(out).toMatchObject({ success: true, message: "partial_success" })
        expect((out as any).outcomes).toEqual({ first: "ok", second: "unknown" })
        expect(out.results.second).toMatchObject({ result: "unknown", hash: "0x02" })
    })

    it("counts a success without a hash as failed", async () => {
        payReplies.push({ result: "success", hash: "0x01" }, { result: "success" })
        const out = await XMDispatcher.digest(script as any)
        expect(out).toMatchObject({ success: true, message: "partial_success" })
        expect((out as any).outcomes).toEqual({ first: "ok", second: "failed" })
    })

    it("refuses an all-failed run", async () => {
        payReplies.push({ result: "error" }, { result: "error" })
        expect(await XMDispatcher.digest(script as any)).toMatchObject({ success: false, message: "all_ops_failed" })
    })
})
