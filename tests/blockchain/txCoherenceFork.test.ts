/**
 * Audit H1 — validateTxCoherence must canonicalize via the fork-aware
 * serializer, not raw JSON.stringify, and must thread the node-supplied
 * isPostFork flag through to it.
 *
 * The real SDK serializer is an ESM build file jest can't load; it has its own
 * tests. Here we stub serializeTransactionContent with a controlled fn that
 * records its (content, isPostFork) args and returns a deterministic string,
 * then assert validateTxCoherence: (a) calls it with the forwarded isPostFork,
 * (b) reports coherent iff sha256(serialized) === tx.hash.
 */

import { describe, expect, it, jest } from "@jest/globals"
import { createHash } from "crypto"

const calls: Array<{ content: unknown; isPostFork: boolean }> = []
// Deterministic stub: prefix encodes the fork flag so post/pre-fork produce
// DIFFERENT serialized bytes for the same content (mirrors the real divergence).
jest.mock(
    "../../node_modules/@kynesyslabs/demosdk/build/denomination/serializerGate.js",
    () => ({
        __esModule: true,
        serializeTransactionContent: (content: unknown, isPostFork: boolean) => {
            calls.push({ content, isPostFork })
            return `${isPostFork ? "OS" : "DEM"}:${JSON.stringify(content)}`
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
    it("forwards isPostFork to the serializer", () => {
        calls.length = 0
        const content = { type: "native", amount: 5 }
        const hash = sha256(`OS:${JSON.stringify(content)}`)
        validateTxCoherence(makeTx(content, hash), true)
        expect(calls.at(-1)?.isPostFork).toBe(true)

        validateTxCoherence(makeTx(content, hash), false)
        expect(calls.at(-1)?.isPostFork).toBe(false)
    })

    it("coherent when hash matches the post-fork serialization", () => {
        const content = { type: "native", amount: 5 }
        const hash = sha256(`OS:${JSON.stringify(content)}`)
        const r = validateTxCoherence(makeTx(content, hash), true)
        expect(r.valid).toBe(true)
    })

    it("coherent when hash matches the pre-fork serialization", () => {
        const content = { type: "native", amount: 5 }
        const hash = sha256(`DEM:${JSON.stringify(content)}`)
        const r = validateTxCoherence(makeTx(content, hash), false)
        expect(r.valid).toBe(true)
    })

    it("NOT coherent when a post-fork tx is checked with pre-fork shape", () => {
        // hash committed over OS shape, but checked with isPostFork=false ->
        // serializer yields DEM:... -> mismatch. This is the exact H1 bug the
        // fix prevents from silently passing/failing inconsistently.
        const content = { type: "native", amount: 5 }
        const hash = sha256(`OS:${JSON.stringify(content)}`)
        const r = validateTxCoherence(makeTx(content, hash), false)
        expect(r.valid).toBe(false)
        expect(r.reason).toMatch(/not coherent/i)
    })

    it("NOT coherent when content is tampered", () => {
        const content = { type: "native", amount: 5 }
        const hash = sha256(`OS:${JSON.stringify(content)}`)
        const tampered = { type: "native", amount: 6 }
        const r = validateTxCoherence(makeTx(tampered, hash), true)
        expect(r.valid).toBe(false)
    })
})
