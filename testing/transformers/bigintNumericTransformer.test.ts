/**
 * Tests for `bigintNumericTransformer.from` — the load-bearing safety guard
 * for the sqlite test path. Production uses Postgres' string round-trip
 * which is intrinsically safe, but the sqlite-backed unit-test harness
 * coerces wide `numeric` values to JS `number` BEFORE the transformer
 * runs, so any value beyond `Number.MAX_SAFE_INTEGER` has already lost
 * precision. The guard turns the silent corruption into a loud
 * `RangeError` so test fixtures cannot accidentally pass while pretending
 * to migrate post-fork OS magnitudes.
 *
 * Refs: PR #812 review (CR-3213220469), epic #9 task 79.
 */

import { describe, it, expect } from "bun:test"
import { bigintNumericTransformer } from "@/model/entities/transformers"

describe("bigintNumericTransformer.from", () => {
    it("returns null for null and undefined", () => {
        expect(bigintNumericTransformer.from(null)).toBeNull()
        expect(bigintNumericTransformer.from(undefined)).toBeNull()
    })

    it("coerces Postgres-style strings losslessly", () => {
        expect(bigintNumericTransformer.from("0")).toBe(0n)
        expect(bigintNumericTransformer.from("100")).toBe(100n)
        // Beyond MAX_SAFE_INTEGER — strings are intrinsically lossless.
        expect(
            bigintNumericTransformer.from(
                "10000000000000000000000000000",
            ),
        ).toBe(10_000_000_000_000_000_000_000_000_000n)
    })

    it("accepts sqlite-style numbers when within Number.MAX_SAFE_INTEGER", () => {
        expect(bigintNumericTransformer.from(0)).toBe(0n)
        expect(bigintNumericTransformer.from(100)).toBe(100n)
        // The boundary value is still representable as a precise integer.
        expect(
            bigintNumericTransformer.from(Number.MAX_SAFE_INTEGER),
        ).toBe(BigInt(Number.MAX_SAFE_INTEGER))
    })

    it("throws RangeError when sqlite returns a number > MAX_SAFE_INTEGER", () => {
        // The smallest unsafe positive integer.
        expect(() =>
            bigintNumericTransformer.from(Number.MAX_SAFE_INTEGER + 1),
        ).toThrow(RangeError)
        expect(() =>
            bigintNumericTransformer.from(Number.MAX_SAFE_INTEGER + 1),
        ).toThrow(/MAX_SAFE_INTEGER/)
    })

    it("throws RangeError when sqlite returns a fractional number", () => {
        // Number.isSafeInteger requires the value to be both safe AND an
        // integer; fractional numbers should be rejected even when within
        // the safe range, because BigInt() would otherwise raise its own
        // generic error and the `numeric` column was supposed to hold a
        // bigint-shaped value.
        expect(() => bigintNumericTransformer.from(1.5)).toThrow(RangeError)
    })

    it("throws RangeError on NaN and Infinity", () => {
        expect(() => bigintNumericTransformer.from(Number.NaN)).toThrow(
            RangeError,
        )
        expect(() =>
            bigintNumericTransformer.from(Number.POSITIVE_INFINITY),
        ).toThrow(RangeError)
        expect(() =>
            bigintNumericTransformer.from(Number.NEGATIVE_INFINITY),
        ).toThrow(RangeError)
    })

    it("persist side stringifies bigints and passes null through", () => {
        expect(bigintNumericTransformer.to(0n)).toBe("0")
        expect(bigintNumericTransformer.to(123n)).toBe("123")
        expect(bigintNumericTransformer.to(null)).toBeNull()
        expect(bigintNumericTransformer.to(undefined)).toBeNull()
    })

    // GH#3214964779: negative-number coverage. The transformer is
    // symmetric — Number.isSafeInteger and BigInt() both accept negatives.
    // Genesis balances are non-negative by spec, but the column type is
    // not constrained at the DB layer, so a malformed migration or seed
    // could produce a negative; the transformer must not crash and must
    // round-trip lossy.
    it("round-trips negative bigints through both directions", () => {
        expect(bigintNumericTransformer.to(-1n)).toBe("-1")
        expect(bigintNumericTransformer.to(-1_000_000_000n)).toBe(
            "-1000000000",
        )
        expect(bigintNumericTransformer.from("-1")).toBe(-1n)
        expect(bigintNumericTransformer.from("-1000000000")).toBe(
            -1_000_000_000n,
        )
        expect(bigintNumericTransformer.from(-100)).toBe(-100n)
        expect(
            bigintNumericTransformer.from(Number.MIN_SAFE_INTEGER),
        ).toBe(BigInt(Number.MIN_SAFE_INTEGER))
    })

    it("throws RangeError when sqlite returns a negative number < MIN_SAFE_INTEGER", () => {
        expect(() =>
            bigintNumericTransformer.from(Number.MIN_SAFE_INTEGER - 1),
        ).toThrow(RangeError)
        expect(() =>
            bigintNumericTransformer.from(Number.MIN_SAFE_INTEGER - 1),
        ).toThrow(/MAX_SAFE_INTEGER/)
    })
})
