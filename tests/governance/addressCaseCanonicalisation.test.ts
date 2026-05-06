// Regression test for G-1 + G-4 (PR #778): the system canonicalises
// validator and account addresses to lowercase at every persistence
// boundary, so RPC validation (which lowercases the sender) and the
// stored validator set agree.

import { describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        custom: jest.fn(),
    },
}))

import {
    canonicalAddress,
    requireSender,
} from "@/libs/network/utils/txHelpers"

describe("txHelpers — address canonicalisation (G-1 + G-4)", () => {
    describe("requireSender", () => {
        it("lowercases tx.content.from", () => {
            const tx = {
                content: { from: "0xAbC123DeF456" },
            } as any
            expect(requireSender(tx)).toBe("0xabc123def456")
        })

        it("lowercases tx.content.from_ed25519_address when from is missing", () => {
            const tx = {
                content: { from_ed25519_address: "DEADbeef" },
            } as any
            expect(requireSender(tx)).toBe("deadbeef")
        })

        it("returns null when neither field is set", () => {
            expect(requireSender({ content: {} } as any)).toBeNull()
            expect(requireSender({ content: null } as any)).toBeNull()
            expect(requireSender({} as any)).toBeNull()
        })

        it("returns null on empty strings", () => {
            const tx = {
                content: { from: "", from_ed25519_address: "" },
            } as any
            expect(requireSender(tx)).toBeNull()
        })

        it("prefers `from` when both fields are set", () => {
            const tx = {
                content: {
                    from: "0xPRIMARY",
                    from_ed25519_address: "FALLBACK",
                },
            } as any
            expect(requireSender(tx)).toBe("0xprimary")
        })
    })

    describe("canonicalAddress", () => {
        it("lowercases a normal hex address", () => {
            expect(canonicalAddress("0xAbCdEf123")).toBe("0xabcdef123")
        })

        it("returns empty string on null / undefined / empty", () => {
            expect(canonicalAddress(null)).toBe("")
            expect(canonicalAddress(undefined)).toBe("")
            expect(canonicalAddress("")).toBe("")
        })

        it("is idempotent", () => {
            const once = canonicalAddress("0xAbCdEf")
            const twice = canonicalAddress(once)
            expect(once).toBe(twice)
        })

        it("matches what requireSender produces — round-trip invariant", () => {
            const tx = { content: { from: "0xMixedCASE" } } as any
            const senderFromTx = requireSender(tx)
            const senderFromCanonical = canonicalAddress("0xMixedCASE")
            expect(senderFromTx).toBe(senderFromCanonical)
        })
    })
})
