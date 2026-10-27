/**
 * Audit H1: validateTxCoherence must canonicalize through the node's
 * fork-aware serializer (serializeTxContent), not raw JSON.stringify, and must
 * thread the node-supplied isPostFork flag through to it.
 *
 * The node serializer runs for real. Only the SDK's post-fork serializer it
 * delegates to is stubbed, because that file is an ESM build jest cannot load
 * (it has its own tests). The stub records each call and prefixes its output
 * so post-fork bytes differ from the raw JSON.stringify the chain hashes
 * pre-fork, which is the divergence the gate exists for.
 */

import { describe, expect, it, jest } from "@jest/globals"
import { createHash } from "crypto"

const sdkCalls: Array<{ content: unknown; isPostFork: boolean }> = []
jest.mock(
    "../../node_modules/@kynesyslabs/demosdk/build/denomination/serializerGate.js",
    () => ({
        __esModule: true,
        serializeTransactionContent: (content: any, isPostFork: boolean) => {
            sdkCalls.push({ content, isPostFork })
            if (content?.amount === "malformed") {
                throw new Error("amount is not a valid OS amount")
            }
            return `OS:${JSON.stringify(content)}`
        },
    }),
)

// unifiedCrypto is imported at module top; stub it so the import resolves.
jest.mock(
    "../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto.js",
    () => ({
        __esModule: true,
        unifiedCrypto: {},
        hexToUint8Array: (h: string) => new Uint8Array(Buffer.from(h, "hex")),
    }),
)

import type { Transaction } from "@kynesyslabs/demosdk/types"
import { validateTxCoherence } from "@/libs/blockchain/validation/txValidator"

function sha256(s: string): string {
    return createHash("sha256").update(s).digest("hex")
}

function makeTx(content: object, hash: string): Transaction {
    return { hash, content } as unknown as Transaction
}

describe("validateTxCoherence fork-aware canonicalization (audit H1)", () => {
    const content = { type: "native", amount: 5 }
    const postForkHash = sha256(`OS:${JSON.stringify(content)}`)
    const preForkHash = sha256(JSON.stringify(content))

    it("post-fork serializes through the SDK OS shape", () => {
        sdkCalls.length = 0
        const r = validateTxCoherence(makeTx(content, postForkHash), true)
        expect(r.valid).toBe(true)
        expect(sdkCalls).toHaveLength(1)
        expect(sdkCalls[0].isPostFork).toBe(true)
        expect(sdkCalls[0].content).toEqual(content)
    })

    it("pre-fork hashes the raw JSON.stringify without the SDK serializer", () => {
        sdkCalls.length = 0
        const r = validateTxCoherence(makeTx(content, preForkHash), false)
        expect(r.valid).toBe(true)
        expect(sdkCalls).toHaveLength(0)
    })

    it("NOT coherent when a post-fork tx is checked with the pre-fork shape", () => {
        // Hash committed over the OS shape but judged pre-fork: the raw bytes
        // differ, so the tx must be rejected rather than silently admitted.
        const r = validateTxCoherence(makeTx(content, postForkHash), false)
        expect(r.valid).toBe(false)
        expect(r.reason).toMatch(/not coherent/i)
    })

    it("NOT coherent when a pre-fork tx is checked with the post-fork shape", () => {
        const r = validateTxCoherence(makeTx(content, preForkHash), true)
        expect(r.valid).toBe(false)
        expect(r.reason).toMatch(/not coherent/i)
    })

    it("NOT coherent when content is tampered", () => {
        const tampered = { type: "native", amount: 6 }
        const r = validateTxCoherence(makeTx(tampered, postForkHash), true)
        expect(r.valid).toBe(false)
    })

    it("rejects content the post-fork serializer cannot canonicalize", () => {
        const bad = { type: "native", amount: "malformed" }
        const r = validateTxCoherence(makeTx(bad, postForkHash), true)
        expect(r.valid).toBe(false)
        expect(r.reason).toMatch(/cannot be serialized/i)
    })
})
