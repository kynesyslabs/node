import { describe, expect, it } from "bun:test"
import { jcsCanonicalize } from "@/libs/crypto/jcs"

// ASCII-only source: build unicode forms via code points so bytes are exact.
const DECOMPOSED = String.fromCodePoint(0x65, 0x301) // "e" + combining acute
const COMPOSED = String.fromCodePoint(0xe9) // precomposed e-acute

describe("jcsCanonicalize", () => {
    it("sorts object keys (UTF-16 code units)", () => {
        expect(jcsCanonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}')
    })

    it("preserves array order and recurses", () => {
        expect(jcsCanonicalize({ z: [{ b: 2, a: 1 }], a: "x" })).toBe(
            '{"a":"x","z":[{"a":1,"b":2}]}',
        )
    })

    it("NFC-normalizes string values (CF-1): decomposed -> composed", () => {
        expect(jcsCanonicalize({ k: DECOMPOSED })).toBe(`{"k":"${COMPOSED}"}`)
        expect(jcsCanonicalize({ k: DECOMPOSED })).toBe(
            jcsCanonicalize({ k: COMPOSED }),
        )
        expect(DECOMPOSED).not.toBe(COMPOSED)
    })

    it("NFC-normalizes object keys AND keeps their values", () => {
        expect(jcsCanonicalize({ [DECOMPOSED]: 5 })).toBe(`{"${COMPOSED}":5}`)
    })

    it("serializes null/boolean/integer", () => {
        expect(jcsCanonicalize({ a: null, b: true, c: 42 })).toBe(
            '{"a":null,"b":true,"c":42}',
        )
    })

    it("strict: rejects non-JSON values", () => {
        expect(() => jcsCanonicalize({ a: undefined as unknown })).toThrow()
        expect(() => jcsCanonicalize({ a: 10n as unknown })).toThrow()
        expect(() => jcsCanonicalize({ a: (() => 1) as unknown })).toThrow()
        expect(() => jcsCanonicalize({ a: NaN })).toThrow()
    })

    it("rejects circular references", () => {
        const o: Record<string, unknown> = {}
        o.self = o
        expect(() => jcsCanonicalize(o)).toThrow()
    })
})
