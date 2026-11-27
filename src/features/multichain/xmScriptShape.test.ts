/**
 * An XM script is checked before a fee is quoted and before any operation is
 * sent: operations is a plain object of at most MAX_XM_OPERATIONS entries,
 * each naming a known chain, a subchain and a known task.
 */

import { describe, expect, it } from "bun:test"
import { MAX_XM_OPERATIONS } from "src/utilities/constants"
import { demoScriptXmRefusal, xmScriptRefusal } from "./xmScriptShape"

function op(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        chain: "eth",
        subchain: "sepolia",
        is_evm: true,
        rpc: "",
        task: { type: "pay", params: null, signedPayloads: ["0xf86b"] },
        ...overrides,
    }
}

function script(ops: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return { operations: ops, operations_order: Object.keys(ops), ...extra }
}

describe("xmScriptRefusal", () => {
    it("accepts the shapes the SDK builders produce", () => {
        expect(xmScriptRefusal(script({ a: op() }))).toBeNull()
        // aptos read: rpc null, empty payload list
        expect(
            xmScriptRefusal(
                script({
                    aptos_contract_read: op({
                        chain: "aptos",
                        subchain: "testnet",
                        is_evm: false,
                        rpc: null,
                        task: { type: "contract_read", params: { moduleAddress: "0x1" }, signedPayloads: [] },
                    }),
                }),
            ),
        ).toBeNull()
        // solana: payload is a serialized byte array object; numeric EVM subchain
        expect(
            xmScriptRefusal(
                script({
                    s: op({ chain: "solana", subchain: "devnet", is_evm: false, task: { type: "pay", signedPayloads: [{ 0: 1, 1: 2 }] } }),
                    e: op({ subchain: 11155111 }),
                }),
            ),
        ).toBeNull()
    })

    const bad: Array<[string, unknown, string]> = [
        ["a non-object script", "x", "not an object"],
        ["an array script", [], "not an object"],
        ["operations as an array", { operations: [op()] }, "operations must be an object"],
        ["operations as a class instance", { operations: Object.assign(new (class Ops {})(), { a: op() }) }, "operations must be an object"],
        ["no operations", script({}), "no operations"],
        ["an unknown chain", script({ a: op({ chain: "nowhere" }) }), "unknown chain"],
        ["an inherited chain name", script({ a: op({ chain: "constructor" }) }), "unknown chain"],
        ["an empty subchain", script({ a: op({ subchain: "" }) }), "no subchain"],
        ["a string is_evm", script({ a: op({ is_evm: "yes" }) }), "is_evm"],
        ["a numeric rpc", script({ a: op({ rpc: 5 }) }), "rpc"],
        ["no task", script({ a: op({ task: undefined }) }), "no task"],
        ["an unknown task", script({ a: op({ task: { type: "drain", signedPayloads: [] } }) }), "unknown task type"],
        ["string params", script({ a: op({ task: { type: "pay", params: "x", signedPayloads: [] } }) }), "params"],
        ["signedPayloads not a list", script({ a: op({ task: { type: "pay", signedPayloads: "0x" } }) }), "not a list"],
        ["a numeric payload", script({ a: op({ task: { type: "pay", signedPayloads: [1] } }) }), "signed payload"],
        ["a bad operations_order", script({ a: op() }, { operations_order: [1] }), "operations_order"],
        ["an overlong name", script({ ["n".repeat(200)]: op() }), "name over"],
    ]
    for (const [label, value, reason] of bad) {
        it(`refuses ${label}`, () => {
            expect(xmScriptRefusal(value)).toContain(reason)
        })
    }

    it("refuses more operations than the limit", () => {
        const ops: Record<string, unknown> = {}
        for (let i = 0; i <= MAX_XM_OPERATIONS; i++) ops[`op${i}`] = op()
        expect(xmScriptRefusal(script(ops, { operations_order: undefined }))).toContain(
            `at most ${MAX_XM_OPERATIONS} entries`,
        )
        delete ops[`op${MAX_XM_OPERATIONS}`]
        expect(xmScriptRefusal(script(ops))).toBeNull()
    })
})

describe("demoScriptXmRefusal", () => {
    it("checks xm steps and leaves other contexts alone", () => {
        const steps = {
            w: { context: "web2", content: { anything: true } },
            x: { context: "xm", content: script({ a: op() }) },
        }
        expect(demoScriptXmRefusal({ steps })).toBeNull()
        const broken = { ...steps, y: { context: "xm", content: script({ a: op({ chain: 1 }) }) } }
        expect(demoScriptXmRefusal({ steps: broken })).toContain("unknown chain")
    })
})
