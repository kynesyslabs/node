import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { jcsCanonicalize } from "@/libs/crypto/jcs"

/**
 * The vectors are the contract with the reference implementation. They were
 * checked in but never executed, and the implementation had drifted from them
 * in two ways that change consensus identity — so they run first here.
 */
interface JcsVectors {
    accepts: { name: string; input: unknown; canonical: string }[]
    rejects: { name: string; input: unknown; error: string }[]
}
const vectors: JcsVectors = JSON.parse(
    readFileSync(join(import.meta.dir, "__fixtures__", "jcs_diff.vectors.json"), "utf8"),
)

describe("the reference vectors", () => {
    it("covers a meaningful number of cases", () => {
        expect(vectors.accepts.length).toBeGreaterThan(10)
        expect(vectors.rejects.length).toBeGreaterThan(0)
    })

    for (const vector of vectors.accepts) {
        it(`canonicalizes ${vector.name} exactly`, () => {
            expect(jcsCanonicalize(vector.input)).toBe(vector.canonical)
        })
    }

    for (const vector of vectors.rejects) {
        it(`refuses ${vector.name}`, () => {
            expect(() => jcsCanonicalize(vector.input)).toThrow()
        })
    }
})

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

    it("leaves object keys exactly as received", () => {
        // Normalizing a key would change the bytes of any payload carrying a
        // decomposed one, and could collapse two distinct keys into one member.
        expect(jcsCanonicalize({ [DECOMPOSED]: 5 })).toBe(`{"${DECOMPOSED}":5}`)
        expect(jcsCanonicalize({ [DECOMPOSED]: 5 })).not.toBe(
            jcsCanonicalize({ [COMPOSED]: 5 }),
        )
    })

    it("normalizes a value but not the key it sits under", () => {
        expect(jcsCanonicalize({ [DECOMPOSED]: DECOMPOSED })).toBe(
            `{"${DECOMPOSED}":"${COMPOSED}"}`,
        )
    })

    it("refuses numbers with no agreed canonical spelling", () => {
        expect(() => jcsCanonicalize({ a: 1.5 })).toThrow(/non-integer/)
        expect(() => jcsCanonicalize({ a: 2 ** 53 })).toThrow(/safe range/)
        expect(() => jcsCanonicalize({ a: -(2 ** 53) })).toThrow(/safe range/)
        expect(jcsCanonicalize({ a: Number.MAX_SAFE_INTEGER })).toBe(
            '{"a":9007199254740991}',
        )
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
