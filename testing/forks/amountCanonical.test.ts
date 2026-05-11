/**
 * Tests for the shared `canonicalizeAmountToOs` helper (myc#76,
 * GH#3213223280).
 *
 * Asserts:
 *  1. Pre-fork (`forkActive=false`): wire shapes (number, string,
 *     bigint) coerce to a DEM-magnitude bigint without scaling, so the
 *     executor's pre-fork balance arithmetic stays bit-identical to
 *     pre-P3a behaviour.
 *  2. Post-fork (`forkActive=true`): wire shapes coerce to OS-magnitude
 *     bigint matching the serializer's `transformToOsTransactionContent`
 *     conversion, so the executor's post-fork balance arithmetic
 *     agrees with the hash binding.
 *  3. Edge cases: `null`/`undefined` map to `0n`; negative, NaN,
 *     Infinity, fractional, malformed-string inputs throw with a clear
 *     message.
 *  4. Cross-callsite parity: serializer and executor produce the same
 *     bigint for the same wire input under the same fork state. This
 *     is the load-bearing invariant the helper exists to guarantee.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { canonicalizeAmountToOs } from "@/forks/amountCanonical"
import { serializeTransactionContent } from "@/forks/serializerGate"
import {
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import { denomination } from "@kynesyslabs/demosdk"
import type { TransactionContent } from "@kynesyslabs/demosdk/types"

describe("canonicalizeAmountToOs — pre-fork (forkActive=false)", () => {
    it("coerces number to DEM bigint without scaling", () => {
        expect(canonicalizeAmountToOs(0, false)).toBe(0n)
        expect(canonicalizeAmountToOs(1, false)).toBe(1n)
        expect(canonicalizeAmountToOs(1234567, false)).toBe(1234567n)
    })

    it("coerces decimal-integer string to DEM bigint without scaling", () => {
        expect(canonicalizeAmountToOs("100", false)).toBe(100n)
        expect(canonicalizeAmountToOs("0", false)).toBe(0n)
    })

    it("passes through bigint unchanged", () => {
        expect(canonicalizeAmountToOs(0n, false)).toBe(0n)
        expect(canonicalizeAmountToOs(42n, false)).toBe(42n)
    })

    it("maps null/undefined to 0n", () => {
        expect(canonicalizeAmountToOs(null, false)).toBe(0n)
        expect(canonicalizeAmountToOs(undefined, false)).toBe(0n)
    })

    it("throws on fractional pre-fork number", () => {
        expect(() => canonicalizeAmountToOs(1.5, false)).toThrow(
            /pre-fork DEM number must be an integer/,
        )
    })

    it("throws on NaN/Infinity number", () => {
        expect(() => canonicalizeAmountToOs(NaN, false)).toThrow(
            /non-finite number/,
        )
        expect(() => canonicalizeAmountToOs(Infinity, false)).toThrow(
            /non-finite number/,
        )
        expect(() => canonicalizeAmountToOs(-Infinity, false)).toThrow(
            /non-finite number|negative number/,
        )
    })

    it("throws on negative number/bigint/string", () => {
        expect(() => canonicalizeAmountToOs(-1, false)).toThrow(
            /negative number/,
        )
        expect(() => canonicalizeAmountToOs(-1n, false)).toThrow(
            /negative bigint/,
        )
        expect(() => canonicalizeAmountToOs("-5", false)).toThrow(
            /negative string amount/,
        )
    })

    it("throws on malformed string", () => {
        expect(() => canonicalizeAmountToOs("not-a-number", false)).toThrow(
            /malformed DEM string/,
        )
        expect(() => canonicalizeAmountToOs("", false)).toThrow(
            /empty string/,
        )
        expect(() => canonicalizeAmountToOs("   ", false)).toThrow(
            /empty string/,
        )
    })
})

describe("canonicalizeAmountToOs — post-fork (forkActive=true)", () => {
    it("scales number DEM→OS via demToOs", () => {
        expect(canonicalizeAmountToOs(0, true)).toBe(0n)
        expect(canonicalizeAmountToOs(1, true)).toBe(denomination.demToOs(1))
        expect(canonicalizeAmountToOs(100, true)).toBe(
            denomination.demToOs(100),
        )
    })

    it("parses string as canonical OS via parseOsString", () => {
        expect(canonicalizeAmountToOs("0", true)).toBe(0n)
        expect(canonicalizeAmountToOs("100000000000", true)).toBe(
            100_000_000_000n,
        )
        expect(canonicalizeAmountToOs("1000000000000000000", true)).toBe(
            1_000_000_000_000_000_000n,
        )
    })

    it("passes bigint through unchanged (already OS)", () => {
        expect(canonicalizeAmountToOs(0n, true)).toBe(0n)
        expect(canonicalizeAmountToOs(1_000_000_000n, true)).toBe(
            1_000_000_000n,
        )
        const max = BigInt(Number.MAX_SAFE_INTEGER)
        expect(canonicalizeAmountToOs(max, true)).toBe(max)
    })

    it("maps null/undefined to 0n", () => {
        expect(canonicalizeAmountToOs(null, true)).toBe(0n)
        expect(canonicalizeAmountToOs(undefined, true)).toBe(0n)
    })

    it("throws on negative inputs", () => {
        expect(() => canonicalizeAmountToOs(-1, true)).toThrow(
            /negative number/,
        )
        expect(() => canonicalizeAmountToOs(-1n, true)).toThrow(
            /negative bigint/,
        )
        expect(() => canonicalizeAmountToOs("-5", true)).toThrow()
    })

    it("throws on NaN/Infinity number", () => {
        expect(() => canonicalizeAmountToOs(NaN, true)).toThrow(
            /non-finite number/,
        )
        expect(() => canonicalizeAmountToOs(Infinity, true)).toThrow(
            /non-finite number/,
        )
    })

    it("throws on malformed OS string", () => {
        expect(() => canonicalizeAmountToOs("not-os", true)).toThrow(
            /malformed OS string/,
        )
        expect(() => canonicalizeAmountToOs("", true)).toThrow(
            /empty string/,
        )
    })
})

describe("canonicalizeAmountToOs — serializer + executor parity", () => {
    let snapshot: ForkConfigByName

    beforeEach(() => {
        snapshot = cloneDefaultForkConfig()
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = snapshot
    })

    function sampleContent(
        amount: TransactionContent["amount"],
    ): TransactionContent {
        return {
            type: "native",
            from: "0x" + "ab".repeat(32),
            from_ed25519_address: "0x" + "cd".repeat(32),
            to: "0x" + "ef".repeat(32),
            amount,
            data: ["native", { description: "transfer" }] as any,
            gcr_edits: [],
            nonce: 1,
            timestamp: 1_700_000_000_000,
            transaction_fee: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
            },
        }
    }

    it("post-fork: helper output matches the serializer's wire amount string", () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 0

        // Legacy pre-3.1.0 SDK shape: amount is a JS number (DEM).
        const legacyNumberInput = 100
        const helperBigint = canonicalizeAmountToOs(
            legacyNumberInput as any,
            true,
        )
        const wire = serializeTransactionContent(
            sampleContent(legacyNumberInput),
            0,
        )
        const parsed = JSON.parse(wire)
        expect(parsed.amount).toBe(denomination.toOsString(helperBigint))
        expect(helperBigint).toBe(denomination.demToOs(legacyNumberInput))

        // SDK 3.1.0+ shape: amount is an OS decimal string.
        const osStringInput = "100000000000"
        const helperBigint2 = canonicalizeAmountToOs(
            osStringInput as any,
            true,
        )
        const wire2 = serializeTransactionContent(
            sampleContent(osStringInput as any),
            0,
        )
        const parsed2 = JSON.parse(wire2)
        expect(parsed2.amount).toBe(denomination.toOsString(helperBigint2))
        expect(helperBigint2).toBe(100_000_000_000n)
    })

    it("pre-fork: helper output equals the BigInt cast of the wire value", () => {
        // activationHeight=null => pre-fork everywhere. Wire is a DEM
        // number; executor previously used `BigInt(content.amount)` for
        // balance arithmetic. The helper must produce the same bigint so
        // behaviour is bit-identical to pre-myc#76.
        for (const amount of [0, 1, 1234567, 9_007_199_254_740_991]) {
            expect(canonicalizeAmountToOs(amount, false)).toBe(BigInt(amount))
        }
    })
})
