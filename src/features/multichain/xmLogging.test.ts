/**
 * An XM script carries the caller's signed payloads. The node logs the
 * shape of a script (op names, task, chain) and never the payloads, and an
 * executor that returns nothing is reported as a failed op instead of
 * throwing after the send.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test"

const lines: string[] = []
const record = (...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
}
const recordingLog = {
    debug: jest.fn(record),
    info: jest.fn(record),
    warn: jest.fn(record),
    warning: jest.fn(record),
    error: jest.fn(record),
    only: jest.fn(record),
}
mock.module("@/utilities/logger", () => ({ __esModule: true, default: recordingLog }))
mock.module("src/utilities/logger", () => ({ __esModule: true, default: recordingLog }))

let payReply: unknown = { result: "success", hash: "0xabc" }
mock.module("./routines/executors/pay", () => ({
    __esModule: true,
    default: async () => payReply,
    genericJsonRpcPay: async () => payReply,
}))

const { default: XMDispatcher } = await import("./XMDispatcher")

const SECRET = "f86b8085e8d4a5100082520894" + "de".repeat(40)

function script(): any {
    return {
        operations: {
            sendIt: {
                chain: "eth",
                subchain: "sepolia",
                is_evm: true,
                rpc: "",
                task: { type: "pay", params: {}, signedPayloads: [SECRET] },
            },
        },
        operations_order: ["sendIt"],
    }
}

afterEach(() => {
    lines.length = 0
    payReply = { result: "success", hash: "0xabc" }
})

describe("XM logging", () => {
    it("never logs a signed payload", async () => {
        await XMDispatcher.digest(script())
        expect(lines.length).toBeGreaterThan(0)
        expect(lines.join("\n")).not.toContain(SECRET)
        expect(lines.join("\n")).toContain("sendIt")
    })
})

describe("an executor that returns nothing", () => {
    for (const reply of [null, undefined, "sent"]) {
        it(`reports ${String(reply)} as a failed op`, async () => {
            payReply = reply
            const out = await XMDispatcher.digest(script())
            expect(out.results.sendIt).toMatchObject({
                result: "error",
                chain: "eth.sepolia",
            })
        })
    }
})
