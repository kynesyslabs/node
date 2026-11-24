/**
 * logField turns a caller-supplied field into one log value: a JSON-escaped
 * string of at most 64 characters inside its quotes, or the field's type.
 * errorKind gives only an error's class and its code when that is a short
 * [A-Z0-9_] token: a message or short message can quote a revert reason that
 * echoes the call arguments. logEntries logs at most 10 entries of a
 * caller-supplied object or array, and walks nothing else.
 */

import { describe, expect, it, jest } from "bun:test"
import { AbiCoder } from "ethers"
import errorKind, { logEntries, logField } from "./errorKind"

const SECRET = "secret-call-argument-123"

describe("errorKind", () => {
    it("logs no part of a revert reason that echoes a call argument", () => {
        // What ethers throws when the contract reverts with Error(SECRET)
        const revertData =
            "0x08c379a0" +
            AbiCoder.defaultAbiCoder().encode(["string"], [SECRET]).slice(2)
        const error = AbiCoder.getBuiltinCallException(
            "call",
            { to: "0x0000000000000000000000000000000000000001", data: "0x" },
            revertData,
        )
        expect(error.shortMessage).toBe(`execution reverted: "${SECRET}"`)

        const logged = errorKind(error)

        expect(logged).toBe("Error CALL_EXCEPTION")
        for (const part of [SECRET, "secret", "123", "reverted", "\""]) {
            expect(logged).not.toContain(part)
        }
    })

    it("logs no message, short message, reason or name set on the error", () => {
        const error = Object.assign(new Error(SECRET), {
            shortMessage: SECRET,
            reason: SECRET,
            name: SECRET,
        })

        expect(errorKind(error)).toBe("Error")
        expect(errorKind({ message: SECRET, name: SECRET })).toBe("Object")
    })

    it("logs no code that is long, holds a newline or is not an [A-Z0-9_] token", () => {
        for (const code of [
            "A".repeat(33),
            "CALL_EXCEPTION\n[ERROR] forged entry",
            SECRET,
            "",
            -32000,
        ]) {
            expect(errorKind(Object.assign(new Error("x"), { code }))).toBe("Error")
        }
        expect(errorKind(Object.assign(new Error("x"), { code: "A".repeat(32) }))).toBe(
            `Error ${"A".repeat(32)}`,
        )
    })

    it("logs the class of a plain error and the type of anything that is not an object", () => {
        expect(errorKind(new TypeError("0xsecret"))).toBe("TypeError")
        expect(errorKind(Object.create(null))).toBe("object")
        expect(errorKind(null)).toBe("object")
        expect(errorKind(undefined)).toBe("undefined")
        expect(errorKind("0xsecret")).toBe("string")
    })
})

describe("logField", () => {
    it("logs a long string with a newline as one escaped value of at most 64 characters plus quotes", () => {
        const value = "eth\n" + "x".repeat(1000)

        const logged = logField(value)

        expect(logged).toBe(`"eth\\n${"x".repeat(59)}"`)
        expect(logged.length).toBeLessThanOrEqual(66)
        expect(logged).not.toContain("\n")
        expect(value.startsWith(JSON.parse(logged))).toBe(true)
    })

    it("keeps a short string whole", () => {
        expect(logField("sepolia")).toBe("\"sepolia\"")
    })

    it("escapes DEL, C1 controls and U+2028/U+2029 as \\uXXXX", () => {
        const rawControls = /[\u007f-\u009f\u2028\u2029]/

        for (const [value, expected] of [
            ["\u009b31m", "\"\\u009b31m\""],
            ["x\u2028y", "\"x\\u2028y\""],
            ["x\u2029y", "\"x\\u2029y\""],
            ["\u007f\u0080\u0085\u009f", "\"\\u007f\\u0080\\u0085\\u009f\""],
        ]) {
            const logged = logField(value)

            expect(logged).toBe(expected)
            expect(logged).not.toMatch(rawControls)
            expect(JSON.parse(logged)).toBe(value)
        }
    })

    it("leaves characters next to the escaped ranges as they are", () => {
        expect(logField("~\u00a0é\u2027\u202a")).toBe("\"~\u00a0é\u2027\u202a\"")
    })

    it("never cuts an escape sequence in half", () => {
        for (const filler of ["\\", "\"", "\u0001", "\u009b", "\u2028", "😀"]) {
            for (let pad = 0; pad < 8; pad++) {
                const logged = logField("a".repeat(pad) + filler.repeat(100))

                expect(logged.length).toBeLessThanOrEqual(66)
                expect(() => JSON.parse(logged)).not.toThrow()
            }
        }
    })

    it("logs anything that is not a string as its type", () => {
        expect(logField(undefined)).toBe("undefined")
        expect(logField(null)).toBe("object")
        expect(logField(7)).toBe("number")
        expect(logField({ url: "https://rpc.example/" })).toBe("object")
    })
})

describe("logEntries", () => {
    const describeEntry = (entry: any) => logField(entry?.context)

    it("lists every entry of a short object or array", () => {
        const steps = { a: { context: "xm" }, b: { context: "web2" } }

        expect(logEntries(steps, "step(s)", describeEntry)).toBe("2 step(s): \"xm\", \"web2\"")
        expect(logEntries(Object.values(steps), "step(s)", describeEntry)).toBe(
            "2 step(s): \"xm\", \"web2\"",
        )
    })

    it("lists the first 10 entries and counts the rest", () => {
        const steps = Object.fromEntries(
            Array.from({ length: 1000 }, (_, i) => [`s${i}`, { context: `c${i}` }]),
        )
        const first10 = Array.from({ length: 10 }, (_, i) => `"c${i}"`).join(", ")

        expect(logEntries(steps, "step(s)", describeEntry)).toBe(
            `1000 step(s): ${first10}, 990 more`,
        )
    })

    it("counts anything that is not an object or an array as empty, and does not walk a long string", () => {
        const describeAndCount = jest.fn(describeEntry)
        const long = "a".repeat(4_000_000)

        const started = performance.now()
        const logged = logEntries(long, "step(s)", describeAndCount)
        const elapsed = performance.now() - started

        expect(logged).toBe("0 step(s): ")
        expect(elapsed).toBeLessThan(100)
        for (const value of [undefined, null, 7, true]) {
            expect(logEntries(value, "step(s)", describeAndCount)).toBe("0 step(s): ")
        }
        expect(describeAndCount).not.toHaveBeenCalled()
    })

    it("lists a long array without walking it", () => {
        // [0,0,...] with 2,000,000 entries fits in a 4 MiB request body
        const long = JSON.parse("[" + "0,".repeat(1_999_999) + "0]")

        const started = performance.now()
        const logged = logEntries(long, "step(s)", describeEntry)
        const elapsed = performance.now() - started

        expect(logged).toBe(`2000000 step(s): ${Array(10).fill("undefined").join(", ")}, 1999990 more`)
        expect(elapsed).toBeLessThan(100)
    })
})
