/**
 * The SDK registers commitments and reads nullifiers in canonical decimal, the
 * form snarkjs gives public signals in, so the read routes must accept it.
 */

import { describe, expect, it } from "bun:test"
import { commitmentLookupKeys, nullifierStorageKey } from "./zkMerkle"

const decimal = "5418378536479590880711971844539863976069607699031562485509841777671898661334"
const hex = BigInt(decimal).toString(16).padStart(64, "0")

describe("ZK route keys", () => {
    it("looks a decimal commitment up as given, then in hex", () => {
        expect(commitmentLookupKeys(decimal)).toEqual([decimal, hex])
    })

    it("looks a hex commitment up lowercased without 0x, then in decimal", () => {
        expect(commitmentLookupKeys(`0x${hex.toUpperCase()}`)).toEqual([hex, decimal])
    })

    it("stores and reads nullifiers in canonical decimal", () => {
        expect(nullifierStorageKey(decimal)).toBe(decimal)
        expect(nullifierStorageKey(`0x${hex}`)).toBe(decimal)
    })

    it("reads a 64-digit nullifier as the decimal the proof stores", () => {
        const digits = "1".repeat(64)
        expect(nullifierStorageKey(digits)).toBe(digits)
        expect(nullifierStorageKey(`0x${digits}`)).toBe(BigInt(`0x${digits}`).toString())
    })

    it("looks a 64-digit commitment up in both readings, decimal first", () => {
        const digits = "1".repeat(64)
        expect(commitmentLookupKeys(digits)).toEqual([
            digits,
            BigInt(digits).toString(16).padStart(64, "0"),
            BigInt(`0x${digits}`).toString(),
        ])
    })

    it("reduces a nullifier to the field, as the verifier stores it", () => {
        const order = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617")
        expect(nullifierStorageKey(`0x${(order + 1n).toString(16)}`)).toBe("1")
        expect(nullifierStorageKey((order + 1n).toString())).toBe("1")
    })

    it("refuses anything that is not a field-sized number", () => {
        for (const bad of ["", "0123", "1".repeat(79), "0x1234", "abc", `${decimal}'--`]) {
            expect(commitmentLookupKeys(bad)).toBeNull()
            expect(nullifierStorageKey(bad)).toBeNull()
        }
    })
})
