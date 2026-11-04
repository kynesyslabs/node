import { describe, expect, it } from "bun:test"
import { canonicalJson } from "./canonicalJson"
import { jcsCanonicalize } from "./jcs"

describe("canonicalJson", () => {
    it("spells primitives as JSON.stringify does", () => {
        expect(canonicalJson(null)).toBe("null")
        expect(canonicalJson(true)).toBe("true")
        expect(canonicalJson(false)).toBe("false")
        expect(canonicalJson(0)).toBe("0")
        expect(canonicalJson("a\"b\\c\n")).toBe("\"a\\\"b\\\\c\\n\"")
    })

    it("accepts every finite number, floats included", () => {
        const cases: [number, string][] = [
            [1.5, "1.5"],
            [0.1 + 0.2, "0.30000000000000004"],
            [-3.25, "-3.25"],
            [1e21, "1e+21"],
            [1e-7, "1e-7"],
            [Number.MAX_SAFE_INTEGER + 2, "9007199254740992"],
            [Number.MAX_VALUE, "1.7976931348623157e+308"],
            [Number.MIN_VALUE, "5e-324"],
        ]
        for (const [n, spelled] of cases) {
            expect(canonicalJson(n)).toBe(spelled)
            expect(canonicalJson({ n })).toBe(`{"n":${spelled}}`)
        }
    })

    it("spells negative zero as 0", () => {
        expect(canonicalJson(-0)).toBe("0")
        expect(canonicalJson([-0, 0])).toBe("[0,0]")
    })

    it("sorts keys at every depth and keeps array order", () => {
        const value = { b: 1, a: { d: [3, { z: 1, y: 2 }, 1], c: null }, A: true, "": 0 }
        expect(canonicalJson(value)).toBe(
            "{\"\":0,\"A\":true,\"a\":{\"c\":null,\"d\":[3,{\"y\":2,\"z\":1},1]},\"b\":1}",
        )
    })

    it("does not depend on insertion order", () => {
        const a = { x: 1, y: { p: 1, q: 2 }, z: [1, 2] }
        const b = { z: [1, 2], y: { q: 2, p: 1 }, x: 1 }
        expect(canonicalJson(a)).toBe(canonicalJson(b))
    })

    it("sorts keys by UTF-16 code units, not code points", () => {
        // U+FF61 sorts after the surrogate pair of U+1F600 by code point, but
        // before it by UTF-16 code unit (0xFF61 > 0xD83D).
        const value = { "｡": 1, "\u{1f600}": 2, "é": 3, z: 4 }
        expect(canonicalJson(value)).toBe("{\"z\":4,\"é\":3,\"\u{1f600}\":2,\"｡\":1}")
    })

    it("does not normalize strings or keys", () => {
        const composed = "é"
        const decomposed = "é"
        expect(canonicalJson(composed)).not.toBe(canonicalJson(decomposed))
        expect(canonicalJson({ [decomposed]: decomposed })).toBe(`{"${decomposed}":"${decomposed}"}`)
        // Where JCS would collapse them.
        expect(jcsCanonicalize(decomposed)).toBe(jcsCanonicalize(composed))
    })

    it("keeps non-ASCII text as is and escapes lone surrogates", () => {
        expect(canonicalJson("日本語 \u{1f600}")).toBe("\"日本語 \u{1f600}\"")
        expect(canonicalJson("\ud800")).toBe("\"\\ud800\"")
    })

    it("follows JSON for undefined, functions and symbols below the top level", () => {
        expect(canonicalJson({ a: undefined, b: () => 1, c: Symbol("s"), d: 1 })).toBe("{\"d\":1}")
        expect(canonicalJson([undefined, () => 1, Symbol("s")])).toBe("[null,null,null]")
    })

    it("honours toJSON and unwraps boxed primitives, like JSON.stringify", () => {
        const date = new Date(Date.UTC(2026, 10, 4, 12, 0, 0))
        expect(canonicalJson({ at: date })).toBe("{\"at\":\"2026-11-04T12:00:00.000Z\"}")
        expect(canonicalJson([new Number(2), new String("s"), new Boolean(false)])).toBe("[2,\"s\",false]")
    })

    it("equals the canonical form of its JSON round trip", () => {
        const value = {
            n: [1.5, -0, 1e21],
            s: "é",
            nested: { b: [true, null, undefined], a: new Date(0) },
            gone: undefined,
        }
        expect(canonicalJson(JSON.parse(JSON.stringify(value)))).toBe(canonicalJson(value))
    })

    it("accepts shared references that are not cycles", () => {
        const shared = { k: 1 }
        expect(canonicalJson({ a: shared, b: [shared, shared] })).toBe("{\"a\":{\"k\":1},\"b\":[{\"k\":1},{\"k\":1}]}")
    })

    it("refuses values JSON cannot carry faithfully", () => {
        expect(() => canonicalJson(undefined)).toThrow()
        expect(() => canonicalJson(() => 1)).toThrow()
        expect(() => canonicalJson(Symbol("s"))).toThrow()
        expect(() => canonicalJson(Number.NaN)).toThrow()
        expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow()
        expect(() => canonicalJson([Number.NEGATIVE_INFINITY])).toThrow()
        expect(() => canonicalJson(10n)).toThrow()
        expect(() => canonicalJson({ a: 10n })).toThrow()
        expect(() => canonicalJson(new Map([["a", 1]]))).toThrow()
        expect(() => canonicalJson({ s: new Set([1]) })).toThrow()
        expect(() => canonicalJson(new Uint8Array([1]))).toThrow()
    })

    it("refuses cycles", () => {
        const obj: Record<string, unknown> = { a: 1 }
        obj.self = obj
        expect(() => canonicalJson(obj)).toThrow(/circular/)
        const arr: unknown[] = [1]
        arr.push({ back: arr })
        expect(() => canonicalJson(arr)).toThrow(/circular/)
    })
})
