/**
 * Audit C4 — L2PS passthrough gcr_edits conservation guard.
 *
 * validateEditConservation enforces, over a participant-signed L2PS tx's
 * balance edits: (1) a `remove` may only debit the signer's account, and
 * (2) Σremove === Σadd (zero-sum). This blocks the forged-mint / theft vectors
 * that the non-binding ZK proof and the per-edit validator do not catch.
 *
 * The method is pure (no DB/SDK at runtime), accessed via cast. The logger is
 * mocked so importing the executor doesn't drag in the datasource chain (and
 * trip jest-haste-map on the .ccb agent-workspace clones).
 */

import { describe, expect, it, jest } from "@jest/globals"

// forgeUtils -> logger -> sharedState -> chain -> datasource (which uses .js
// imports jest can't resolve). Mock logger to cut that chain; editConservation
// only needs forgeToHex.
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}))

import type { GCREdit } from "@kynesyslabs/demosdk/types"
import { validateEditConservation } from "@/libs/l2ps/editConservation"

const SIGNER = "0x" + "aa".repeat(32)
const RECIPIENT = "0x" + "bb".repeat(32)
const VICTIM = "0x" + "cc".repeat(32)

const validate = (edits: GCREdit[], from: string) =>
    validateEditConservation(edits, [from])

const bal = (
    operation: "add" | "remove",
    account: string,
    amount: number | string,
): GCREdit =>
    ({ type: "balance", operation, account, amount } as unknown as GCREdit)

describe("L2PS validateEditConservation (audit C4)", () => {
    it("accepts a zero-sum transfer debiting the signer", () => {
        const r = validate(
            [bal("remove", SIGNER, 100), bal("add", RECIPIENT, 100)],
            SIGNER,
        )
        expect(r.success).toBe(true)
    })

    it("rejects an unbalanced mint (add with no matching remove)", () => {
        const r = validate([bal("add", SIGNER, 1_000_000)], SIGNER)
        expect(r.success).toBe(false)
        expect(r.message).toMatch(/zero-sum/i)
    })

    it("rejects debiting another account (theft)", () => {
        const r = validate(
            [bal("remove", VICTIM, 100), bal("add", SIGNER, 100)],
            SIGNER,
        )
        expect(r.success).toBe(false)
        expect(r.message).toMatch(/only debit the signer/i)
    })

    it("rejects a partial mint (remove < add)", () => {
        const r = validate(
            [bal("remove", SIGNER, 50), bal("add", RECIPIENT, 100)],
            SIGNER,
        )
        expect(r.success).toBe(false)
        expect(r.message).toMatch(/zero-sum/i)
    })

    it("rejects a negative amount", () => {
        const r = validate([bal("remove", SIGNER, -5)], SIGNER)
        expect(r.success).toBe(false)
        expect(r.message).toMatch(/negative/i)
    })

    it("accepts when there are no balance edits (nonce-only)", () => {
        const r = validate(
            [{ type: "nonce", account: SIGNER, amount: 1 } as unknown as GCREdit],
            SIGNER,
        )
        expect(r.success).toBe(true)
    })

    it("accepts a multi-recipient split funded by the signer", () => {
        const r = validate(
            [
                bal("remove", SIGNER, 100),
                bal("add", RECIPIENT, 60),
                bal("add", VICTIM, 40),
            ],
            SIGNER,
        )
        expect(r.success).toBe(true)
    })
})
